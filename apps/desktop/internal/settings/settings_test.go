package settings

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type fakeSecrets map[string]string

func (s fakeSecrets) Get(key string) (string, error) { return s[key], nil }

func (s fakeSecrets) Set(key, value string) error {
	s[key] = value
	return nil
}

func (s fakeSecrets) Delete(key string) error {
	delete(s, key)
	return nil
}

func TestConfigPersistenceAndSecretStatus(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app", "settings.json")
	keychain := fakeSecrets{"LARK_APP_SECRET": "fake-lark-secret-with-long-value"}
	store := NewStore(path, keychain)
	initial, err := store.Load()
	if err != nil || initial.Alerts != AlertsInherit {
		t.Fatalf("load missing config: alerts=%q, err=%v", initial.Alerts, err)
	}

	config := Config{
		NodePath:          "/Users/test/Node Bin/node",
		WorkspacePath:     "/Users/test/bot",
		CodexPath:         "/Users/test/bin/codex",
		StatePath:         "/Users/test/bot-state",
		AppID:             "cli_demo",
		OwnerOpenID:       "ou_owner",
		TestGroupChatID:   "oc_tests",
		ExpectedRepos:     "Example/Bot",
		MergeAllowedRepos: "Example/Bot",
		MergeMethod:       "squash",
		TrackedPRs:        "Example/Bot#42",
		PollSeconds:       "180",
		WebhookRepository: "Example/Bot",
		WebhookPort:       "8787",
		Alerts:            AlertsOff,
	}
	if err := store.Save(config); err != nil {
		t.Fatal(err)
	}
	reopened := NewStore(path, keychain)
	loaded, err := reopened.Load()
	if err != nil || loaded != config {
		t.Fatalf("config after reopen: %+v, err=%v", loaded, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), keychain["LARK_APP_SECRET"]) || strings.Contains(string(data), "LARK_APP_SECRET") {
		t.Fatal("persisted settings contain a Keychain field or value")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("settings file permissions = %o", info.Mode().Perm())
	}
	files, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(files) != 1 || files[0].Name() != "settings.json" {
		t.Fatalf("settings directory after save: %v, err=%v", files, err)
	}

	if err := reopened.SetSecret("GH_TOKEN", " fake-github-token "); err != nil {
		t.Fatal(err)
	}
	status, err := reopened.SecretStatus()
	if err != nil || !status["LARK_APP_SECRET"] || !status["GH_TOKEN"] || status["GH_MERGE_TOKEN"] {
		t.Fatalf("unexpected Keychain status: %v, err=%v", status, err)
	}
	if keychain["GH_TOKEN"] != "fake-github-token" {
		t.Fatal("secret was not written to the Keychain adapter")
	}
	if err := reopened.DeleteSecret("GH_TOKEN"); err != nil {
		t.Fatal(err)
	}
	if _, exists := keychain["GH_TOKEN"]; exists {
		t.Fatal("secret survived deletion")
	}
}

func TestEnvironmentUsesConfiguredValuesAndPreservesFallback(t *testing.T) {
	store := NewStore("", fakeSecrets{
		"LARK_APP_SECRET":   "keychain-lark",
		"GH_TOKEN":          "keychain-github",
		"GH_WEBHOOK_SECRET": "keychain-webhook",
	})
	inherited := []string{
		"PATH=/opt/homebrew/bin:/usr/bin",
		"LARK_APP_ID=cli_older",
		"LARK_APP_SECRET=inherited-lark",
		"GH_TOKEN=inherited-github",
		"GH_ORG_TOKEN=inherited-org",
		"GH_MERGE_METHOD=rebase",
		"GH_WEBHOOK_REPOSITORY=Example/Events",
		"LARK_GITHUB_ALERTS=1",
		"MARKER=value=with=equals",
	}
	config := Config{
		AppID:             "cli_new",
		MergeAllowedRepos: "Example/Bot",
		CodexPath:         "/Users/test/Codex Bin/codex",
		Alerts:            AlertsOff,
	}
	environment, err := store.Environment(config, inherited)
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]string{
		"PATH":                  "/opt/homebrew/bin:/usr/bin",
		"LARK_APP_ID":           "cli_new",
		"LARK_APP_SECRET":       "keychain-lark",
		"GH_TOKEN":              "keychain-github",
		"GH_ORG_TOKEN":          "inherited-org",
		"GH_MERGE_METHOD":       "rebase",
		"GH_MERGE_REPOSITORIES": "Example/Bot",
		"GH_WEBHOOK_REPOSITORY": "",
		"GH_WEBHOOK_SECRET":     "",
		"OAR_CODEX_BIN":         "/Users/test/Codex Bin/codex",
		"LARK_GITHUB_ALERTS":    "0",
		"MARKER":                "value=with=equals",
	}
	if actual := environmentMap(environment); !reflect.DeepEqual(actual, expected) {
		t.Fatalf("child environment = %v, want %v", actual, expected)
	}

	for _, alerts := range []string{"", AlertsInherit, AlertsOn} {
		explicit, err := store.Environment(Config{Alerts: alerts}, []string{"GH_WEBHOOK_REPOSITORY=Example/Events"})
		if err != nil {
			t.Fatal(err)
		}
		value, exists := environmentMap(explicit)["LARK_GITHUB_ALERTS"]
		if exists != (alerts == AlertsOn) || (exists && value != "1") {
			t.Fatalf("alerts=%q produced inherited flag %q, present=%v", alerts, value, exists)
		}
		env := environmentMap(explicit)
		if env["GH_WEBHOOK_SECRET"] != "keychain-webhook" || env["GH_WEBHOOK_REPOSITORY"] != "Example/Events" {
			t.Fatalf("alerts=%q did not preserve Webhook configuration", alerts)
		}
	}
}

func environmentMap(entries []string) map[string]string {
	values := make(map[string]string, len(entries))
	for _, entry := range entries {
		key, value, _ := strings.Cut(entry, "=")
		values[key] = value
	}
	return values
}

func TestValidateLaunchChecksExecutablesAndWorkspaceDependencies(t *testing.T) {
	workspace := t.TempDir()
	node := filepath.Join(workspace, "node")
	if err := os.WriteFile(node, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(workspace, "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "src", "lark.ts"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := []byte(`{"dependencies":{"@example/sdk":"1.0.0","lib":"2.0.0"}}`)
	if err := os.WriteFile(filepath.Join(workspace, "package.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	config := Config{NodePath: node, WorkspacePath: workspace}
	if err := config.ValidateLaunch(); err == nil || !strings.Contains(err.Error(), "@example/sdk, lib") {
		t.Fatalf("dependency validation error = %v", err)
	}
	for _, dependency := range []string{"@example/sdk", "lib"} {
		if err := os.MkdirAll(filepath.Join(workspace, "node_modules", dependency), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := config.ValidateLaunch(); err != nil {
		t.Fatal(err)
	}
	config.CodexPath = node
	config.StatePath = filepath.Join(workspace, "not-created-yet")
	if err := config.ValidateLaunch(); err != nil {
		t.Fatal(err)
	}
	config.NodePath = "node"
	if err := config.ValidateLaunch(); err == nil {
		t.Fatal("relative Node path was accepted")
	}
}

func TestLaunchEntrypointUsesTheBotAppManifestAndDependencies(t *testing.T) {
	workspace := t.TempDir()
	app := filepath.Join(workspace, "apps", "bot")
	node := filepath.Join(workspace, "node")
	for path, body := range map[string]string{
		node:                                     "#!/bin/sh\n",
		filepath.Join(workspace, "package.json"): `{}`,
		filepath.Join(workspace, "src", "lark.ts"): "",
		filepath.Join(app, "package.json"):         `{"dependencies":{"only-in-app":"1.0.0"}}`,
		filepath.Join(app, "src", "lark.ts"):       "",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(workspace, "node_modules", "only-in-app"), 0o700); err != nil {
		t.Fatal(err)
	}
	config := Config{NodePath: node, WorkspacePath: workspace}
	if _, err := config.LaunchEntrypoint(); err == nil || !strings.Contains(err.Error(), "only-in-app") {
		t.Fatalf("missing app-local dependency was not detected: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(app, "node_modules", "only-in-app"), 0o700); err != nil {
		t.Fatal(err)
	}
	entrypoint, err := config.LaunchEntrypoint()
	if err != nil || entrypoint != "apps/bot/src/lark.ts" {
		t.Fatalf("preferred entrypoint = %q, error = %v", entrypoint, err)
	}
}

type failingSecrets struct{}

func (failingSecrets) Get(string) (string, error) {
	return "", errors.New("unexpected secret returned by credential provider")
}

func (failingSecrets) Set(string, string) error {
	return errors.New("unexpected secret returned by credential provider")
}

func (failingSecrets) Delete(string) error { return errors.New("credential provider failed") }

func TestSecretErrorsDoNotExposeProviderDetails(t *testing.T) {
	store := NewStore("", failingSecrets{})
	_, err := store.SecretStatus()
	if err == nil || !strings.Contains(err.Error(), "LARK_APP_SECRET") || strings.Contains(err.Error(), "unexpected secret") {
		t.Fatalf("unexpected status error: %v", err)
	}
	err = store.SetSecret("GH_TOKEN", "fake-github")
	if err == nil || !strings.Contains(err.Error(), "GH_TOKEN") || strings.Contains(err.Error(), "unexpected secret") {
		t.Fatalf("unexpected save error: %v", err)
	}
}
