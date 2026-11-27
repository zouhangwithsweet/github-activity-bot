package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github-activity-bot/desktop/internal/bot"
	"github-activity-bot/desktop/internal/settings"
)

type botController struct {
	store *settings.Store

	operation sync.Mutex
	currentMu sync.RWMutex
	current   *bot.Supervisor
}

func (c *botController) process() *bot.Supervisor {
	c.currentMu.RLock()
	defer c.currentMu.RUnlock()
	return c.current
}

func (c *botController) snapshot() bot.Snapshot {
	if current := c.process(); current != nil {
		return current.Snapshot()
	}
	return bot.Snapshot{State: bot.Stopped}
}

func (c *botController) start(restart bool) error {
	c.operation.Lock()
	defer c.operation.Unlock()

	cfg, err := c.store.Load()
	if err != nil {
		return err
	}
	entrypoint, err := cfg.LaunchEntrypoint()
	if err != nil {
		return err
	}
	env, err := c.store.Environment(cfg, os.Environ())
	if err != nil {
		return err
	}
	if current := c.process(); current != nil {
		state := current.Snapshot().State
		if state != bot.Stopped && state != bot.Failed {
			if !restart {
				return errors.New("Bot 已启动")
			}
			if err := current.Stop(); err != nil {
				return err
			}
		}
	}
	if anotherBotIn(cfg.WorkspacePath) {
		return errors.New("这个项目的 Bot 已在终端运行。请先在原终端按 Ctrl+C，再从菜单栏启动")
	}
	next := bot.New(bot.Config{
		NodePath: cfg.NodePath,
		WorkDir:  cfg.WorkspacePath,
		Args:     []string{"--env-file-if-exists=.env", entrypoint},
		Env:      env,
		Log:      io.Discard,
	})
	c.currentMu.Lock()
	c.current = next
	c.currentMu.Unlock()
	return next.Start()
}

func (c *botController) stop() error {
	c.operation.Lock()
	defer c.operation.Unlock()

	if current := c.process(); current != nil {
		if state := current.Snapshot().State; state != bot.Stopped && state != bot.Failed {
			return current.Stop()
		}
	}
	return nil
}

// An existing `pnpm lark` process belongs to its terminal. Leave it in place
// and ask the operator to stop it there before the app opens its own connection.
func anotherBotIn(workspace string) bool {
	workspaceInfo, err := os.Stat(workspace)
	if err != nil {
		return false
	}
	botInfo, _ := os.Stat(filepath.Join(workspace, "apps", "bot"))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	matches, err := exec.CommandContext(ctx, "/usr/bin/pgrep", "-f", "(^|[[:space:]/])src/lark[.]ts($|[[:space:]])").Output()
	if err != nil {
		return false
	}
	for _, pid := range strings.Fields(string(matches)) {
		path, err := exec.CommandContext(ctx, "/bin/ps", "-p", pid, "-o", "comm=").Output()
		if err != nil || filepath.Base(strings.TrimSpace(string(path))) != "node" {
			continue
		}
		cwd, err := exec.CommandContext(ctx, "/usr/sbin/lsof", "-a", "-p", pid, "-d", "cwd", "-Fn").Output()
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(cwd), "\n") {
			if path, ok := strings.CutPrefix(line, "n"); ok {
				if info, err := os.Stat(path); err == nil &&
					(os.SameFile(workspaceInfo, info) || (botInfo != nil && os.SameFile(botInfo, info))) {
					return true
				}
			}
		}
	}
	return false
}
