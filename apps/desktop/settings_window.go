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

var settingsSections = []struct{ id, label string }{
	{"runtime", "运行环境"},
	{"lark", "飞书"},
	{"github", "GitHub"},
	{"alerts", "提醒"},
}

type settingsWindow struct {
	store  *settings.Store
	window *mygo.Window
	config settings.Config
	tab    string

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
		Title: "GitHub Activity Bot 设置", Width: 700, Height: 564,
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
		store: store, tab: settingsSections[0].id, alerts: inheritSetting, mergeMethod: inheritSetting,
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

type settingsColors struct {
	theme    ui.Theme
	sidebar  ui.Color
	hairline ui.Color
}

func settingsAppearance(base *ui.Theme) settingsColors {
	t := *base
	t.Font, t.Radius = "system-ui", 8
	t.AccentText = ui.Hex("#FFFFFF")
	if t.Dark {
		t.Background, t.Surface = ui.Hex("#191C22"), ui.Hex("#22262E")
		t.SurfaceHover, t.SurfacePressed = ui.Hex("#2B313B"), ui.Hex("#323B49")
		t.Border, t.Text, t.TextMuted = ui.Hex("#444E5E"), ui.Hex("#EDF0F5"), ui.Hex("#A6B1C0")
		t.Accent, t.AccentHover, t.AccentPressed = ui.Hex("#416CC4"), ui.Hex("#4774CE"), ui.Hex("#365EAD")
		t.Focus, t.Selection = ui.Hex("#86ADFC"), ui.RGBA(114, 157, 243, .27)
		return settingsColors{t, ui.Hex("#20242C"), ui.Hex("#343C48")}
	}
	t.Background, t.Surface = ui.Hex("#F6F7FA"), ui.Hex("#FFFFFF")
	t.SurfaceHover, t.SurfacePressed = ui.Hex("#F0F3F9"), ui.Hex("#E0E7F3")
	t.Border, t.Text, t.TextMuted = ui.Hex("#CDD5E1"), ui.Hex("#202937"), ui.Hex("#5C677A")
	t.Accent, t.AccentHover, t.AccentPressed = ui.Hex("#3158A5"), ui.Hex("#3A65B7"), ui.Hex("#294C91")
	t.Focus, t.Selection = ui.Hex("#446EC1"), ui.RGBA(65, 107, 195, .22)
	return settingsColors{t, ui.Hex("#EEF1F6"), ui.Hex("#DCE2EB")}
}

func (v *settingsWindow) view(c *ui.Context) {
	look := settingsAppearance(c.Theme())
	c.SetTheme(&look.theme)
	c.Root().Background(look.theme.Background)
	width, _ := c.Size()
	sidebarWidth, inset := float32(148), float32(24)
	if width < 550 {
		sidebarWidth, inset = 112, 16
	}
	ui.Row(c).Fill().Children(func() {
		ui.Sidebar(c.Key("sections"), &v.tab, func() {
			for _, section := range settingsSections {
				ui.SidebarItem(c, section.id, nil, section.label).Height(36)
			}
		}).Width(sidebarWidth).FillHeight().Padding(20, 12).Gap(4).Background(look.sidebar)
		ui.Box(c).Width(1).FillHeight().Shrink(0).Background(look.hairline)
		ui.Column(c).Grow(1).MinWidth(0).FillHeight().Children(func() {
			ui.Scroll(c.Key(v.tab)).Grow(1).MinHeight(0).FillWidth().Children(func() {
				ui.Column(c).FillWidth().Gap(16).Padding(24, inset, 20).Children(func() {
					switch v.tab {
					case "lark":
						v.larkFields(c)
					case "github":
						v.githubFields(c)
					case "alerts":
						v.alertFields(c)
					default:
						v.runtimeFields(c)
					}
				})
			})
			ui.Box(c).Height(1).FillWidth().Shrink(0).Background(look.hairline)
			v.footer(c, inset)
		})
	})
}

func (v *settingsWindow) footer(c *ui.Context, inset float32) {
	message := v.message
	if message == "" {
		message = "更改在下次启动或重启 Bot 后生效"
	}
	textColor := c.Theme().TextMuted
	if v.failed {
		textColor = c.Theme().Danger
	}
	ui.Row(c).FillWidth().Shrink(0).Gap(12).AlignItems(ui.Center).
		Background(c.Theme().Surface).Padding(12, inset).Children(func() {
		ui.Text(c, message).Grow(1).MinWidth(0).FontSize(c.Theme().FontSize - 1).TextColor(textColor)
		ui.PrimaryButton(c.Key("save"), "保存设置").Height(34).Shrink(0).FontWeight(600).
			Disabled(v.busy).OnClick(v.save)
	})
}

func settingsTitle(c *ui.Context, title string) {
	ui.Text(c, title).FontSize(c.Theme().FontSize + 8).FontWeight(600)
}

func settingsCard(c *ui.Context, title string, fields func()) {
	ui.Column(c.Key(title)).FillWidth().Gap(12).Padding(12, 16, 16).Radius(12).
		Background(c.Theme().Surface).Border(1, c.Theme().Border).Children(func() {
		ui.Text(c, title).FontSize(c.Theme().FontSize - 1).FontWeight(600).TextColor(c.Theme().TextMuted)
		fields()
	})
}

func (v *settingsWindow) runtimeFields(c *ui.Context) {
	settingsTitle(c, "运行环境")
	settingsCard(c, "启动配置", func() {
		v.pathField(c, "仓库根目录", &v.config.WorkspacePath, "选择包含 apps/bot 的目录", true)
		v.pathField(c, "Node 可执行文件", &v.config.NodePath, "选择 Node 路径", false)
	})
	settingsCard(c, "可选路径", func() {
		v.pathField(c, "Codex 可执行文件", &v.config.CodexPath, "沿用现有配置", false)
		v.pathField(c, "Bot 数据目录", &v.config.StatePath, "沿用现有数据目录", true)
	})
}

func (v *settingsWindow) larkFields(c *ui.Context) {
	settingsTitle(c, "飞书应用")
	settingsCard(c, "应用与接收范围", func() {
		settingField(c, "App ID", &v.config.AppID, "cli_…")
		settingField(c, "本人 Open ID", &v.config.OwnerOpenID, "ou_…")
		settingField(c, "测试群 Chat ID", &v.config.TestGroupChatID, "可选，oc_…")
	})
	settingsCard(c, "应用凭据", func() {
		v.secret(c, "App Secret", "LARK_APP_SECRET")
	})
	inheritNote(c)
}

func (v *settingsWindow) githubFields(c *ui.Context) {
	settingsTitle(c, "GitHub 查询与合并")
	settingsCard(c, "读取", func() {
		v.secret(c, "GitHub 读取令牌", "GH_TOKEN")
		v.secret(c, "组织读取令牌", "GH_ORG_TOKEN")
		settingField(c, "查询仓库", &v.config.ExpectedRepos, "owner/repo，以逗号分隔")
	})
	settingsCard(c, "合并", func() {
		v.secret(c, "GitHub 合并令牌", "GH_MERGE_TOKEN")
		settingField(c, "允许合并的仓库", &v.config.MergeAllowedRepos, "owner/repo，以逗号分隔")
		ui.Field(c.Key("合并方式"), "合并方式", func() {
			ui.Select(c, &v.mergeMethod, []string{inheritSetting, "squash", "merge", "rebase"}).FillWidth().Height(34)
		})
	})
	inheritNote(c)
}

func (v *settingsWindow) alertFields(c *ui.Context) {
	settingsTitle(c, "GitHub 主动提醒")
	settingsCard(c, "GitHub 轮询", func() {
		ui.Field(c.Key("主动提醒"), "主动提醒", func() {
			ui.Select(c, &v.alerts, []string{inheritSetting, "开启", "关闭"}).FillWidth().Height(34)
		})
		settingField(c, "轮询间隔（秒）", &v.config.PollSeconds, "默认 120")
		settingField(c, "跟踪 PR", &v.config.TrackedPRs, "owner/repo#123，以逗号分隔")
		v.secret(c, "个人通知令牌", "GH_NOTIFICATIONS_TOKEN")
	})
	settingsCard(c, "Webhook", func() {
		settingField(c, "Webhook 仓库", &v.config.WebhookRepository, "可选，owner/repo")
		settingField(c, "Webhook 端口", &v.config.WebhookPort, "默认 8787")
		v.secret(c, "Webhook Secret", "GH_WEBHOOK_SECRET")
	})
	inheritNote(c)
}

func inheritNote(c *ui.Context) {
	ui.Text(c, "留空的项目沿用环境变量或仓库根目录的 .env。").FontSize(c.Theme().FontSize - 1).TextColor(c.Theme().TextMuted)
}

func settingField(c *ui.Context, label string, value *string, placeholder string) {
	ui.Field(c.Key(label), label, func() {
		ui.TextInput(c, value).FillWidth().Height(34).Background(c.Theme().Background).
			Font("monospace, system-ui").FontSize(c.Theme().FontSize - 1).Placeholder(placeholder)
	})
}

func (v *settingsWindow) pathField(c *ui.Context, label string, value *string, placeholder string, directory bool) {
	ui.Field(c.Key(label), label, func() {
		ui.Row(c).Gap(8).Children(func() {
			ui.TextInput(c, value).Grow(1).MinWidth(0).Height(34).Background(c.Theme().Background).
				Font("monospace, system-ui").FontSize(c.Theme().FontSize - 1).Placeholder(placeholder)
			ui.Button(c, "选择…").Height(34).Shrink(0).FontSize(c.Theme().FontSize - 1).
				Label("选择" + label).Disabled(v.busy).OnClick(func() {
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
			ui.TextInput(c, value).Grow(1).MinWidth(0).Height(34).Background(c.Theme().Background).
				Password().Placeholder(placeholder).Disabled(v.busy || v.loading)
			ui.Button(c, "存入").Height(34).Shrink(0).FontSize(c.Theme().FontSize - 1).
				Label("存入" + label).Disabled(v.busy || v.loading || strings.TrimSpace(*value) == "").
				OnClick(func() { v.changeSecret(key, false) })
			if v.stored[key] {
				ui.Button(c, "移除").Height(34).Shrink(0).FontSize(c.Theme().FontSize - 1).
					Label("移除" + label).Disabled(v.busy).
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
