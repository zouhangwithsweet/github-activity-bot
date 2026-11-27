package main

import (
	_ "embed"
	"errors"
	"log"
	"path/filepath"
	"time"

	"github-activity-bot/desktop/internal/bot"
	"github-activity-bot/desktop/internal/settings"
	"github.com/egoist/mygo"
)

const appName = "GitHub Activity Bot"

//go:embed resources/tray.png
var trayIcon []byte

type keychain struct{}

func (keychain) Get(key string) (string, error) {
	value, err := mygo.Secrets.Get(key)
	if errors.Is(err, mygo.ErrSecretNotFound) {
		return "", nil
	}
	return string(value), err
}

func (keychain) Set(key, value string) error {
	return mygo.Secrets.Set(key, []byte(value))
}

func (keychain) Delete(key string) error {
	return mygo.Secrets.Delete(key)
}

type desktopApp struct {
	controller *botController
	tray       *mygo.Tray
	status     *mygo.MenuItem
	start      *mygo.MenuItem
	pause      *mygo.MenuItem
	restart    *mygo.MenuItem
	detail     *mygo.MenuItem
	panel      *mygo.Window
	done       chan struct{}

	busy     bool
	paused   bool
	quitting bool
	canQuit  bool
	lastErr  string
	lastView menuView
}

func main() {
	mygo.App.SetName(appName)
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		log.Fatal(err)
	}
	app := &desktopApp{
		controller: &botController{store: settings.NewStore(filepath.Join(dir, "settings.json"), keychain{})},
		done:       make(chan struct{}),
	}
	mygo.App.OnWindowAllClosed(func() {})
	mygo.App.OnBeforeQuit(app.beforeQuit)
	mygo.App.OnQuit(func() { close(app.done) })
	mygo.App.WhenReady(app.ready)
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

func (a *desktopApp) ready() {
	a.status = &mygo.MenuItem{Label: "Bot 未启动", Disabled: true}
	a.start = action("启动 Bot", func() { a.run(false, false) })
	a.pause = action("暂停 Bot", func() { a.run(true, false) })
	a.restart = action("重启 Bot", func() { a.run(false, true) })
	a.detail = action("查看错误…", a.showError)
	a.tray = mustTray(mygo.NewTray(mygo.TrayOptions{
		ID:             "github-activity-bot",
		Icon:           trayIcon,
		IconIsTemplate: true,
		ToolTip:        appName,
		Menu: mygo.NewMenu([]*mygo.MenuItem{
			a.status, a.detail, mygo.Separator(), a.start, a.pause, a.restart,
			mygo.Separator(), action("设置…", a.showSettings), action("退出", mygo.App.Quit),
		}),
	}))
	a.refreshTray()
	go a.watch()
	cfg, err := a.controller.store.Load()
	if err != nil || cfg.NodePath == "" || cfg.WorkspacePath == "" {
		a.showSettings()
	}
}

func mustTray(tray *mygo.Tray, err error) *mygo.Tray {
	if err != nil {
		log.Fatal("无法创建菜单栏图标: ", err)
	}
	return tray
}

func action(label string, run func()) *mygo.MenuItem {
	return &mygo.MenuItem{Label: label, Click: func(*mygo.MenuItem, *mygo.Window) { run() }}
}

type menuView struct {
	state     string
	startText string
	canStart  bool
	canStop   bool
	hasError  bool
}

func (a *desktopApp) refreshTray() {
	snapshot := a.controller.snapshot()
	view := menuView{state: "Bot 未启动", startText: "启动 Bot"}
	switch snapshot.State {
	case bot.Starting:
		view.state, view.canStop = "正在连接飞书…", true
	case bot.Running:
		view.state, view.canStop = "Bot 运行中", true
		if snapshot.Revision != "" {
			view.state += " · " + snapshot.Revision
		}
	case bot.Stopping:
		view.state = "正在停止 Bot…"
	case bot.Failed:
		view.state = "Bot 启动或运行失败"
	}
	if a.paused && snapshot.State == bot.Stopped {
		view.state, view.startText = "Bot 已暂停", "恢复 Bot"
	}
	if a.busy && snapshot.State != bot.Stopping {
		view.state = "正在处理…"
	}
	view.canStart = !a.busy && !a.quitting && !view.canStop && snapshot.State != bot.Stopping
	view.canStop = view.canStop && !a.busy && !a.quitting
	view.hasError = a.lastErr != "" || snapshot.LastError != ""
	if a.lastView == view {
		return
	}
	a.lastView = view
	a.status.SetLabel(view.state)
	a.tray.SetToolTip(appName + " · " + view.state)
	a.start.SetLabel(view.startText)
	a.start.SetEnabled(view.canStart)
	a.pause.SetEnabled(view.canStop)
	a.restart.SetEnabled(view.canStop)
	a.detail.SetVisible(view.hasError)
}

func (a *desktopApp) watch() {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-a.done:
			return
		case <-ticker.C:
			mygo.RunOnMain(a.refreshTray)
		}
	}
}

func (a *desktopApp) run(pause, restart bool) {
	if a.busy || a.quitting {
		return
	}
	a.busy = true
	a.lastErr = ""
	a.refreshTray()
	go func() {
		var err error
		if pause {
			err = a.controller.stop()
		} else {
			err = a.controller.start(restart)
		}
		mygo.RunOnMain(func() {
			a.busy = false
			if err != nil {
				a.lastErr = err.Error()
			} else {
				a.paused = pause
			}
			a.refreshTray()
			if a.quitting {
				a.finishQuit()
			} else if err != nil {
				a.showError()
			}
		})
	}()
}

func (a *desktopApp) showError() {
	detail := a.lastErr
	if detail == "" {
		detail = a.controller.snapshot().LastError
	}
	if detail != "" {
		go mygo.Dialog.Message(mygo.MessageOptions{
			Type: mygo.MessageWarning, Message: "Bot 操作失败", Detail: detail,
		})
	}
}

func (a *desktopApp) beforeQuit(event *mygo.QuitEvent) {
	if event.SessionEnding {
		_ = a.controller.stop()
		return
	}
	if a.canQuit {
		return
	}
	event.PreventDefault()
	if a.quitting {
		return
	}
	a.quitting = true
	a.refreshTray()
	if !a.busy {
		a.finishQuit()
	}
}

func (a *desktopApp) finishQuit() {
	go func() {
		_ = a.controller.stop()
		mygo.RunOnMain(func() {
			a.canQuit = true
			mygo.App.Quit()
		})
	}()
}
