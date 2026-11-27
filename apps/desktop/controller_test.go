package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github-activity-bot/desktop/internal/bot"
	"github-activity-bot/desktop/internal/settings"
)

const controllerDotenv = "LARK_APP_ID=from-dotenv\nMYGO_BOT_TEST_DOTENV=repo-fallback\n"

const controllerFixture = `
import { appendFileSync } from 'node:fs'
const record = (event) => appendFileSync('launches.jsonl', JSON.stringify({
  event, pid: process.pid, appID: process.env.LARK_APP_ID, dotenv: process.env.MYGO_BOT_TEST_DOTENV
}) + '\n')
process.on('SIGTERM', () => {
  record('stop')
  process.exit(0)
})
record('start')
console.log('Connected to Lark via WebSocket.')
setInterval(() => {}, 1000)
`

type controllerRecord struct {
	Event  string `json:"event"`
	PID    int    `json:"pid"`
	AppID  string `json:"appID"`
	Dotenv string `json:"dotenv"`
}

func controllerNode(t *testing.T, workDir string) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is required to test the actual launch and .env behavior.")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, node, "-p", "JSON.stringify([process.versions.node, process.execPath])")
	command.Dir = workDir
	output, err := command.Output()
	if err != nil {
		t.Fatalf("locate installed Node executable: %v", err)
	}
	var runtime []string
	if err := json.Unmarshal(output, &runtime); err != nil || len(runtime) != 2 {
		t.Fatal("Node executable did not report its version and path.")
	}
	var major, minor int
	if _, err := fmt.Sscanf(runtime[0], "%d.%d", &major, &minor); err != nil {
		t.Fatal("Node executable did not report a valid version.")
	}
	if major < 26 && (major != 24 || minor < 11) {
		t.Skip("The bot requires Node.js 24.11+ LTS or 26+.")
	}
	return runtime[1]
}

func setupController(t *testing.T) (*botController, settings.Config) {
	t.Helper()
	workspace := t.TempDir()
	t.Setenv("LARK_APP_ID", "from-parent")
	t.Setenv("MYGO_BOT_TEST_DOTENV", "")
	if err := os.Unsetenv("MYGO_BOT_TEST_DOTENV"); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(workspace, "apps", "bot", "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, payload := range map[string]string{
		".env":                  controllerDotenv,
		"apps/bot/.env":         "MYGO_BOT_TEST_DOTENV=app-local\n",
		"apps/bot/package.json": `{"type":"module"}`,
		"apps/bot/src/lark.ts":  controllerFixture,
	} {
		if err := os.WriteFile(filepath.Join(workspace, name), []byte(payload), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	config := settings.Config{NodePath: controllerNode(t, workspace), WorkspacePath: workspace}
	store := settings.NewStore(filepath.Join(t.TempDir(), "settings.json"), nil)
	if err := store.Save(config); err != nil {
		t.Fatal(err)
	}
	controller := &botController{store: store}
	t.Cleanup(func() {
		if err := controller.stop(); err != nil {
			t.Error(err)
		}
	})
	return controller, config
}

func waitForController(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(7 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for controller fixture")
}

func controllerRunning(t *testing.T, controller *botController) bot.Snapshot {
	t.Helper()
	var snapshot bot.Snapshot
	waitForController(t, func() bool {
		snapshot = controller.snapshot()
		if snapshot.State == bot.Failed {
			t.Fatalf("controller fixture failed: %s", snapshot.LastError)
		}
		return snapshot.State == bot.Running
	})
	return snapshot
}

func TestBotControllerRestartsWithSavedConfigAndKeepsDotenv(t *testing.T) {
	controller, config := setupController(t)
	if err := controller.start(false); err != nil {
		t.Fatal(err)
	}
	first := controllerRunning(t, controller)
	if err := controller.start(false); err == nil || controller.snapshot().PID != first.PID {
		t.Fatalf("duplicate start did not leave the current process alone: %v", err)
	}

	config.AppID = "from-settings"
	if err := controller.store.Save(config); err != nil {
		t.Fatal(err)
	}
	if err := controller.start(true); err != nil {
		t.Fatal(err)
	}
	second := controllerRunning(t, controller)
	if second.PID == first.PID || second.PID == 0 {
		t.Fatalf("restart did not use a replacement process: %d -> %d", first.PID, second.PID)
	}
	if err := controller.stop(); err != nil {
		t.Fatal(err)
	}
	if got := controller.snapshot(); got.State != bot.Stopped || got.PID != 0 {
		t.Fatalf("pause left the owned bot active: %+v", got)
	}

	runLog, err := os.ReadFile(filepath.Join(config.WorkspacePath, "launches.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var runs []controllerRecord
	for _, line := range bytes.Split(bytes.TrimSpace(runLog), []byte{'\n'}) {
		var record controllerRecord
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		runs = append(runs, record)
	}
	want := []controllerRecord{
		{Event: "start", PID: first.PID, AppID: "from-parent", Dotenv: "repo-fallback"},
		{Event: "stop", PID: first.PID, AppID: "from-parent", Dotenv: "repo-fallback"},
		{Event: "start", PID: second.PID, AppID: "from-settings", Dotenv: "repo-fallback"},
		{Event: "stop", PID: second.PID, AppID: "from-settings", Dotenv: "repo-fallback"},
	}
	if !reflect.DeepEqual(runs, want) {
		t.Fatalf("subprocess order/config: got %+v, want %+v", runs, want)
	}
	dotenv, err := os.ReadFile(filepath.Join(config.WorkspacePath, ".env"))
	if err != nil || string(dotenv) != controllerDotenv {
		t.Fatalf("workspace .env changed: %v", err)
	}
}

func TestBotControllerLeavesSameWorkspaceTerminalBotRunning(t *testing.T) {
	for _, path := range []string{"/usr/bin/pgrep", "/bin/ps", "/usr/sbin/lsof"} {
		if _, err := os.Stat(path); err != nil {
			t.Skip("The macOS process discovery tools are required.")
		}
	}
	for _, fixture := range []struct{ name, directory, entrypoint string }{
		{"legacy command at root", ".", "src/lark.ts"},
		{"monorepo command at root", ".", "apps/bot/src/lark.ts"},
		{"workspace command in app", "apps/bot", "src/lark.ts"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			controller, config := setupController(t)
			if fixture.directory == "." && fixture.entrypoint == "src/lark.ts" {
				if err := os.Mkdir(filepath.Join(config.WorkspacePath, "src"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(config.WorkspacePath, fixture.entrypoint), []byte(controllerFixture), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			terminalBot := exec.Command(config.NodePath, "--env-file-if-exists=.env", fixture.entrypoint)
			terminalBot.Dir = filepath.Join(config.WorkspacePath, fixture.directory)
			if err := terminalBot.Start(); err != nil {
				t.Fatal(err)
			}
			exited := make(chan error, 1)
			go func() { exited <- terminalBot.Wait() }()
			t.Cleanup(func() {
				_ = terminalBot.Process.Signal(syscall.SIGTERM)
				select {
				case <-exited:
				case <-time.After(3 * time.Second):
					_ = terminalBot.Process.Kill()
					<-exited
				}
			})
			waitForController(t, func() bool {
				_, err := os.Stat(filepath.Join(terminalBot.Dir, "launches.jsonl"))
				return err == nil
			})

			if err := controller.start(false); err == nil || !strings.Contains(err.Error(), "已在终端运行") {
				t.Fatalf("controller did not recognize the existing fixture process: %v", err)
			}
			if err := controller.stop(); err != nil {
				t.Fatal(err)
			}
			if got := controller.snapshot(); got.State != bot.Stopped || got.PID != 0 {
				t.Fatalf("controller adopted the terminal process: %+v", got)
			}
			if err := terminalBot.Process.Signal(syscall.Signal(0)); err != nil {
				t.Fatalf("controller stopped the external process: %v", err)
			}
		})
	}
}
