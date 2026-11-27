package bot

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func testSupervisor(t *testing.T, mode, readyFile string, stopTimeout time.Duration) (*Supervisor, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "bot.log")
	log, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = log.Close() })
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	supervisor := New(Config{
		NodePath:    executable,
		WorkDir:     t.TempDir(),
		Args:        []string{"-test.run=^TestSupervisorSubprocess$"},
		Env:         []string{"MYGO_BOT_TEST_MODE=" + mode, "MYGO_BOT_TEST_READY_FILE=" + readyFile},
		Log:         log,
		StopTimeout: stopTimeout,
	})
	t.Cleanup(func() { _ = supervisor.Stop() })
	return supervisor, path
}

func await(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for the bot subprocess")
}

func readLog(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func TestStartReadyAndRestart(t *testing.T) {
	t.Setenv("MYGO_BOT_TEST_PARENT_ONLY", "should-not-reach-the-child")
	readyFile := filepath.Join(t.TempDir(), "start-connection")
	supervisor, log := testSupervisor(t, "graceful", readyFile, 2*time.Second)
	if err := supervisor.Start(); err != nil {
		t.Fatal(err)
	}
	first := supervisor.Snapshot()
	await(t, func() bool { return strings.Contains(readLog(t, log), "ready only when signaled") })
	if got := supervisor.Snapshot(); got.State != Starting || got.PID != first.PID || got.PID <= 0 {
		t.Fatalf("process became ready without the exact stdout line: %+v", got)
	}
	if err := supervisor.Start(); err != ErrAlreadyActive {
		t.Fatalf("duplicate start returned %v", err)
	}
	if err := os.WriteFile(readyFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { return supervisor.Snapshot().State == Running })
	if err := supervisor.Restart(); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { return supervisor.Snapshot().State == Running })
	second := supervisor.Snapshot()
	if second.PID == first.PID || second.PID <= 0 {
		t.Fatalf("restart retained the old process: before %+v after %+v", first, second)
	}
	output := readLog(t, log)
	firstStop := strings.Index(output, fmt.Sprintf("graceful stop %d", first.PID))
	secondStart := strings.Index(output, fmt.Sprintf("start %d", second.PID))
	if firstStop < 0 || secondStart < 0 || firstStop >= secondStart {
		t.Fatalf("replacement started before the previous process stopped:\n%s", output)
	}
	if err := supervisor.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := supervisor.Snapshot(); got.State != Stopped || got.PID != 0 || got.LastError != "" {
		t.Fatalf("graceful stop left unexpected state: %+v", got)
	}
}

func TestForceStopAndReportCrash(t *testing.T) {
	supervisor, _ := testSupervisor(t, "ignore-signal", "", 70*time.Millisecond)
	if err := supervisor.Start(); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { return supervisor.Snapshot().State == Running })
	if err := supervisor.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := supervisor.Snapshot(); got.State != Stopped || got.PID != 0 || !strings.Contains(got.LastError, "forced stop") {
		t.Fatalf("expected a successfully forced stop, got %+v", got)
	}

	crashing, _ := testSupervisor(t, "crash", "", 2*time.Second)
	if err := crashing.Start(); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { return crashing.Snapshot().State == Failed })
	if got := crashing.Snapshot(); got.PID != 0 || !strings.Contains(got.LastError, "exit status 7") {
		t.Fatalf("expected the unexpected exit status, got %+v", got)
	}
}

func TestSupervisorSubprocess(t *testing.T) {
	mode := os.Getenv("MYGO_BOT_TEST_MODE")
	if mode == "" {
		return
	}
	if os.Getenv("MYGO_BOT_TEST_PARENT_ONLY") != "" {
		os.Exit(22)
	}
	if mode == "crash" {
		os.Exit(7)
	}
	if mode == "ignore-signal" {
		signal.Ignore(syscall.SIGTERM)
		fmt.Fprintln(os.Stdout, readyLine)
		for {
			time.Sleep(time.Second)
		}
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM)
	fmt.Fprintf(os.Stdout, "start %d, ready only when signaled\n", os.Getpid())
	fmt.Fprintln(os.Stderr, readyLine)
	fmt.Fprintln(os.Stdout, "not a readiness signal: "+readyLine)
	if path := os.Getenv("MYGO_BOT_TEST_READY_FILE"); path != "" {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			if _, err := os.Stat(path); err == nil {
				break
			}
			select {
			case <-stop:
				os.Exit(0)
			case <-ticker.C:
			}
		}
	}
	fmt.Fprint(os.Stdout, "Connected to Lark")
	fmt.Fprintln(os.Stdout, " via WebSocket.")
	<-stop
	fmt.Fprintf(os.Stdout, "graceful stop %d\n", os.Getpid())
	os.Exit(0)
}
