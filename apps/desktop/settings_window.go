package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github-activity-bot/desktop/internal/settings"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

const inheritSetting = "继承配置"

type settingsWindow struct {
	store  *settings.Store
	window *mygo.Window
	config settings.Config
	tab    int

	alerts      string
	mergeMethod string
	drafts      map[string]*string
	stored      map[string]bool
	loading     bool
	busy        bool
	message     string
	failed      bool
}

func (a *desktopApp) showSettings() {
	if a.panel != nil {
		a.panel.Show()
		a.panel.Focus()
		return
	}
	model := newSettingsWindow(a.controller.store)
	model.window = mygo.NewWindow(mygo.WindowOptions{
		Title: "GitHub Activity Bot 设置", Width: 640, Height: 600,
		MinWidth: 440, MinHeight: 410, Content: ui.View(model.view),
	})
	a.panel = model.window
	a.panel.OnClosed(func() {
		for _, value := range model.drafts {
			*value = ""
		}
		a.panel = nil
	})
	a.panel.Focus()
	model.updateKeychain()
}

func newSettingsWindow(store *settings.Store) *settingsWindow {
	v := &settingsWindow{
		store: store, alerts: inheritSetting, mergeMethod: inheritSetting,
		drafts: make(map[string]*string), loading: true,
	}
	config, err := store.Load()
	v.config = config
	if err != nil {
		v.message, v.failed = err.Error(), true
	}
	if v.config.WorkspacePath == "" {
		v.config.WorkspacePath = suggestWorkspace()
	}
	if v.config.NodePath == "" {
		v.config.NodePath = suggestNode()
	}
	switch v.config.Alerts {
	case settings.AlertsOn:
		v.alerts = "开启"
	case settings.AlertsOff:
		v.alerts = "关闭"
	}
	if v.config.MergeMethod != "" {
		v.mergeMethod = v.config.MergeMethod
	}
	for _, key := range settings.SecretKeys() {
		v.drafts[key] = new(string)
	}
	return v
}

func suggestWorkspace() string {
	directory, _ := os.Getwd()
	executable, _ := os.Executable()
	for _, root := range []string{directory, filepath.Dir(executable)} {
		var legacy string
		for path := root; filepath.IsAbs(path); path = filepath.Dir(path) {
			if entrypoint, err := settings.BotEntrypoint(path); err == nil {
				app := filepath.Join(path, filepath.Dir(filepath.Dir(entrypoint)))
				if _, err := os.Stat(filepath.Join(app, "package.json")); err == nil {
					if entrypoint != "src/lark.ts" {
						return path
					}
					if legacy == "" {
						legacy = path
					}
				}
			}
			if path == filepath.Dir(path) {
				break
			}
		}
		if legacy != "" {
			return legacy
		}
	}
	return ""
}

func suggestNode() string {
	if path, err := exec.LookPath("node"); err == nil && filepath.IsAbs(path) {
		return path
	}
	for _, path := range []string{"/opt/homebrew/bin/node", "/usr/local/bin/node"} {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return path
		}
	}
	return ""
}

func (v *settingsWindow) view(c *ui.Context) {
	c.Root().Background(c.Theme().Surface)
	ui.Column(c).Fill().Gap(12).Padding(20).Children(func() {
		ui.Tabs(c.Key("sections"), &v.tab, "运行", "飞书", "GitHub", "提醒")
		ui.Divider(c)
		ui.Scroll(c.Key(v.tab)).Grow(1).FillWidth().Children(func() {
			ui.Column(c).FillWidth().Gap(16).Padding(2, 12, 12, 2).Children(func() {
				switch v.tab {
				case 0:
					v.runtimeFields(c)
				case 1:
					v.larkFields(c)
				case 2:
					v.githubFields(c)
				case 3:
					v.alertFields(c)
				}
			})
		})
		ui.Divider(c)
		ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
			if v.message != "" {
				status := ui.Text(c, v.message).FontSize(13).Grow(1)
				if v.failed {
					status.TextColor(c.Theme().Danger)
				} else {
					status.TextColor(c.Theme().TextMuted)
				}
			} else {
				ui.Spacer(c)
			}
			ui.PrimaryButton(c.Key("save"), "保存设置").Disabled(v.busy).OnClick(v.save)
		})
	})
}

func (v *settingsWindow) runtimeFields(c *ui.Context) {
	ui.Text(c, "Bot 运行环境").FontSize(18).Bold()
	v.pathField(c, "仓库根目录", &v.config.WorkspacePath, "选择包含 apps/bot 的仓库根目录", true)
	v.pathField(c, "Node 可执行文件", &v.config.NodePath, "node -p 'process.execPath' 可查看实际路径", false)
	v.pathField(c, "Codex 可执行文件", &v.config.CodexPath, "可选，留空时使用现有配置", false)
	v.pathField(c, "Bot 数据目录", &v.config.StatePath, "可选，留空时沿用现有会话和数据目录", true)
}

func (v *settingsWindow) larkFields(c *ui.Context) {
	ui.Text(c, "飞书应用").FontSize(18).Bold()
	settingField(c, "App ID", &v.config.AppID, "cli_…")
	settingField(c, "本人 Open ID", &v.config.OwnerOpenID, "ou_…")
	settingField(c, "测试群 Chat ID", &v.config.TestGroupChatID, "可选，oc_…")
	v.secret(c, "App Secret", "LARK_APP_SECRET")
	inheritNote(c)
}

func (v *settingsWindow) githubFields(c *ui.Context) {
	ui.Text(c, "GitHub 查询与合并").FontSize(18).Bold()
	v.secret(c, "GitHub 读取令牌", "GH_TOKEN")
	v.secret(c, "组织读取令牌", "GH_ORG_TOKEN")
	settingField(c, "查询仓库", &v.config.ExpectedRepos, "owner/repo，以逗号分隔")
	v.secret(c, "GitHub 合并令牌", "GH_MERGE_TOKEN")
	settingField(c, "允许合并的仓库", &v.config.MergeAllowedRepos, "owner/repo，以逗号分隔")
	ui.Field(c.Key("合并方式"), "合并方式", func() {
		ui.Select(c, &v.mergeMethod, []string{inheritSetting, "squash", "merge", "rebase"}).FillWidth()
	})
	inheritNote(c)
}

func (v *settingsWindow) alertFields(c *ui.Context) {
	ui.Text(c, "GitHub 主动提醒").FontSize(18).Bold()
	ui.Field(c.Key("主动提醒"), "主动提醒", func() {
		ui.Select(c, &v.alerts, []string{inheritSetting, "开启", "关闭"}).FillWidth()
	})
	settingField(c, "轮询间隔（秒）", &v.config.PollSeconds, "默认 120")
	settingField(c, "跟踪 PR", &v.config.TrackedPRs, "owner/repo#123，以逗号分隔")
	v.secret(c, "个人通知令牌", "GH_NOTIFICATIONS_TOKEN")
	settingField(c, "Webhook 仓库", &v.config.WebhookRepository, "可选，owner/repo")
	settingField(c, "Webhook 端口", &v.config.WebhookPort, "默认 8787")
	v.secret(c, "Webhook Secret", "GH_WEBHOOK_SECRET")
	inheritNote(c)
}

func inheritNote(c *ui.Context) {
	ui.Text(c, "留空的项目沿用环境变量或仓库根目录的 .env。").FontSize(13).TextColor(c.Theme().TextMuted)
}

func settingField(c *ui.Context, label string, value *string, placeholder string) {
	ui.Field(c.Key(label), label, func() {
		ui.TextInput(c, value).FillWidth().Placeholder(placeholder)
	})
}

func (v *settingsWindow) pathField(c *ui.Context, label string, value *string, placeholder string, directory bool) {
	ui.Field(c.Key(label), label, func() {
		ui.Row(c).Gap(8).Children(func() {
			ui.TextInput(c, value).Grow(1).Placeholder(placeholder)
			ui.Button(c, "选择…").Label("选择" + label).Disabled(v.busy).OnClick(func() {
				go func() {
					paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
						Parent: v.window, Title: label, Directory: directory, ShowHiddenFiles: true,
					})
					mygo.RunOnMain(func() {
						if len(paths) != 0 {
							*value = paths[0]
						}
						v.report("", err)
					})
				}()
			})
		})
	})
}

func (v *settingsWindow) secret(c *ui.Context, label, key string) {
	value := v.drafts[key]
	placeholder := "仅存入 macOS 钥匙串"
	if v.loading {
		placeholder = "正在读取钥匙串…"
	} else if v.stored[key] {
		placeholder = "已存入钥匙串，可输入新值替换"
	}
	ui.Field(c.Key(key), label, func() {
		ui.Row(c).Gap(8).Children(func() {
			ui.TextInput(c, value).Grow(1).Password().Placeholder(placeholder).Disabled(v.busy || v.loading)
			ui.Button(c, "存入").Label("存入" + label).Disabled(v.busy || v.loading || strings.TrimSpace(*value) == "").
				OnClick(func() { v.changeSecret(key, false) })
			if v.stored[key] {
				ui.Button(c, "移除").Label("移除" + label).Disabled(v.busy).
					OnClick(func() { v.changeSecret(key, true) })
			}
		})
	})
}

func (v *settingsWindow) save() {
	config := v.config
	switch v.alerts {
	case "开启":
		config.Alerts = settings.AlertsOn
	case "关闭":
		config.Alerts = settings.AlertsOff
	default:
		config.Alerts = settings.AlertsInherit
	}
	config.MergeMethod = v.mergeMethod
	if config.MergeMethod == inheritSetting {
		config.MergeMethod = ""
	}
	v.busy = true
	go func() {
		err := v.store.Save(config)
		mygo.RunOnMain(func() {
			v.busy = false
			v.report("已保存。下次启动或重启时生效。", err)
		})
	}()
}

func (v *settingsWindow) updateKeychain() {
	go func() {
		status, err := v.store.SecretStatus()
		mygo.RunOnMain(func() {
			v.loading = false
			v.stored = status
			if err != nil {
				v.report("", err)
			} else {
				v.window.Invalidate()
			}
		})
	}()
}

func (v *settingsWindow) changeSecret(key string, remove bool) {
	value := *v.drafts[key]
	v.busy = true
	go func() {
		msg := "已存入钥匙串。下次启动或重启时生效。"
		var err error
		if remove {
			msg = "已从钥匙串移除。下次启动时沿用其他配置。"
			err = v.store.DeleteSecret(key)
		} else {
			err = v.store.SetSecret(key, value)
		}
		mygo.RunOnMain(func() {
			v.busy = false
			if err == nil {
				*v.drafts[key] = ""
				if v.stored == nil {
					v.stored = make(map[string]bool)
				}
				v.stored[key] = !remove
			}
			v.report(msg, err)
		})
	}()
}

func (v *settingsWindow) report(message string, err error) {
	v.failed = err != nil
	v.message = message
	if v.failed {
		v.message = err.Error()
	}
	v.window.Invalidate()
}
