package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

const (
	AlertsInherit = "inherit"
	AlertsOn      = "on"
	AlertsOff     = "off"
)

// Config holds the non-secret settings stored by the desktop app.
type Config struct {
	NodePath          string `json:"nodePath"`
	WorkspacePath     string `json:"workspacePath"`
	CodexPath         string `json:"codexPath,omitempty"`
	StatePath         string `json:"statePath,omitempty"`
	AppID             string `json:"appID,omitempty"`
	OwnerOpenID       string `json:"ownerOpenID,omitempty"`
	TestGroupChatID   string `json:"testGroupChatID,omitempty"`
	ExpectedRepos     string `json:"expectedRepos,omitempty"`
	MergeAllowedRepos string `json:"mergeAllowedRepos,omitempty"`
	MergeMethod       string `json:"mergeMethod,omitempty"`
	TrackedPRs        string `json:"trackedPRs,omitempty"`
	PollSeconds       string `json:"pollSeconds,omitempty"`
	WebhookRepository string `json:"webhookRepository,omitempty"`
	WebhookPort       string `json:"webhookPort,omitempty"`
	Alerts            string `json:"alerts"`
}

// Secrets accesses the Keychain for this desktop app. An absent secret returns an empty string and no error.
type Secrets interface {
	Get(key string) (string, error)
	Set(key, value string) error
	Delete(key string) error
}

var secretKeys = []string{
	"LARK_APP_SECRET",
	"GH_TOKEN",
	"GH_ORG_TOKEN",
	"GH_MERGE_TOKEN",
	"GH_NOTIFICATIONS_TOKEN",
	"GH_WEBHOOK_SECRET",
}

func SecretKeys() []string {
	return slices.Clone(secretKeys)
}

type Store struct {
	path    string
	secrets Secrets
}

func NewStore(path string, secrets Secrets) *Store {
	return &Store{path: path, secrets: secrets}
}

func (s *Store) Load() (Config, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return Config{Alerts: AlertsInherit}, nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("read settings: %w", err)
	}
	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return Config{}, fmt.Errorf("decode settings: %w", err)
	}
	return normalizeConfig(config)
}

func (s *Store) Save(config Config) error {
	config, err := normalizeConfig(config)
	if err != nil {
		return err
	}
	directory := filepath.Dir(s.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create settings directory: %w", err)
	}
	file, err := os.CreateTemp(directory, ".settings-*.json")
	if err != nil {
		return fmt.Errorf("create temporary settings: %w", err)
	}
	defer os.Remove(file.Name())

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(config); err != nil {
		_ = file.Close()
		return fmt.Errorf("encode settings: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync settings: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close settings: %w", err)
	}
	if err := os.Rename(file.Name(), s.path); err != nil {
		return fmt.Errorf("replace settings: %w", err)
	}
	return nil
}

func normalizeConfig(config Config) (Config, error) {
	if config.Alerts == "" {
		config.Alerts = AlertsInherit
	}
	switch config.Alerts {
	case AlertsInherit, AlertsOn, AlertsOff:
		return config, nil
	default:
		return Config{}, errors.New("alerts must be inherit, on, or off")
	}
}

func (s *Store) SecretStatus() (map[string]bool, error) {
	configured := make(map[string]bool, len(secretKeys))
	for _, key := range secretKeys {
		value, err := s.readSecret(key)
		if err != nil {
			return nil, err
		}
		configured[key] = value != ""
	}
	return configured, nil
}

func (s *Store) SetSecret(key, value string) error {
	if !slices.Contains(secretKeys, key) {
		return errors.New("unknown secret setting")
	}
	if s.secrets == nil {
		return errors.New("Keychain is unavailable")
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return errors.New("secret is empty")
	}
	if strings.ContainsRune(value, '\x00') {
		return errors.New("secret contains an invalid character")
	}
	if err := s.secrets.Set(key, value); err != nil {
		return fmt.Errorf("save %s to Keychain", key)
	}
	return nil
}

func (s *Store) DeleteSecret(key string) error {
	if !slices.Contains(secretKeys, key) {
		return errors.New("unknown secret setting")
	}
	if s.secrets == nil {
		return errors.New("Keychain is unavailable")
	}
	if err := s.secrets.Delete(key); err != nil {
		return fmt.Errorf("remove %s from Keychain", key)
	}
	return nil
}

func (s *Store) readSecret(key string) (string, error) {
	if s.secrets == nil {
		return "", nil
	}
	value, err := s.secrets.Get(key)
	if err != nil {
		return "", fmt.Errorf("read %s from Keychain", key)
	}
	value = strings.TrimSpace(value)
	if strings.ContainsRune(value, '\x00') {
		return "", fmt.Errorf("%s contains an invalid character", key)
	}
	return value, nil
}

// Environment builds the child process environment. It contains secrets and must stay in Go.
// Unset settings leave inherited values and the Node launcher’s .env fallback available.
func (s *Store) Environment(config Config, inherited []string) ([]string, error) {
	config, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	values := make(map[string]string, len(inherited)+len(secretKeys))
	for _, entry := range inherited {
		if key, value, ok := strings.Cut(entry, "="); ok && key != "" {
			values[key] = value
		}
	}
	overrides := map[string]string{
		"OAR_CODEX_BIN":            config.CodexPath,
		"LARK_MEMORY_DIR":          config.StatePath,
		"LARK_APP_ID":              config.AppID,
		"LARK_OWNER_OPEN_ID":       config.OwnerOpenID,
		"LARK_TEST_GROUP_CHAT_ID":  config.TestGroupChatID,
		"GH_EXPECTED_REPOS":        config.ExpectedRepos,
		"GH_MERGE_REPOSITORIES":    config.MergeAllowedRepos,
		"GH_MERGE_METHOD":          config.MergeMethod,
		"GH_TRACKED_PRS":           config.TrackedPRs,
		"GH_ACTIVITY_POLL_SECONDS": config.PollSeconds,
		"GH_WEBHOOK_REPOSITORY":    config.WebhookRepository,
		"GH_WEBHOOK_PORT":          config.WebhookPort,
	}
	for key, value := range overrides {
		if strings.TrimSpace(value) == "" {
			continue
		}
		if strings.ContainsRune(value, '\x00') {
			return nil, fmt.Errorf("%s contains an invalid character", key)
		}
		values[key] = value
	}
	switch config.Alerts {
	case AlertsOn:
		values["LARK_GITHUB_ALERTS"] = "1"
	case AlertsOff:
		values["LARK_GITHUB_ALERTS"] = "0"
	}
	for _, key := range secretKeys {
		value, err := s.readSecret(key)
		if err != nil {
			return nil, err
		}
		if value != "" {
			values[key] = value
		}
	}
	if config.Alerts == AlertsOff {
		// Empty environment entries also mask the project's .env values.
		// The saved Webhook settings can be reused when alerts are enabled.
		values["GH_WEBHOOK_REPOSITORY"] = ""
		values["GH_WEBHOOK_SECRET"] = ""
	}
	environment := make([]string, 0, len(values))
	for key, value := range values {
		environment = append(environment, key+"="+value)
	}
	sort.Strings(environment)
	return environment, nil
}

func (config Config) ValidateLaunch() error {
	_, err := config.LaunchEntrypoint()
	return err
}

func (config Config) LaunchEntrypoint() (string, error) {
	if _, err := normalizeConfig(config); err != nil {
		return "", err
	}
	if err := validateExecutable("Node", config.NodePath); err != nil {
		return "", err
	}
	if config.CodexPath != "" {
		if err := validateExecutable("Codex", config.CodexPath); err != nil {
			return "", err
		}
	}
	if config.StatePath != "" && !filepath.IsAbs(config.StatePath) {
		return "", errors.New("state directory must be an absolute path")
	}
	entrypoint, err := BotEntrypoint(config.WorkspacePath)
	if err != nil {
		return "", err
	}
	botDirectory := filepath.Join(config.WorkspacePath, filepath.Dir(filepath.Dir(entrypoint)))
	if err := validateWorkspaceDependencies(botDirectory); err != nil {
		return "", err
	}
	return entrypoint, nil
}

func BotEntrypoint(workspace string) (string, error) {
	if !filepath.IsAbs(workspace) {
		return "", errors.New("bot repository root must be an absolute path")
	}
	for _, entrypoint := range []string{"apps/bot/src/lark.ts", "src/lark.ts"} {
		info, err := os.Stat(filepath.Join(workspace, entrypoint))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() {
			return "", fmt.Errorf("bot entrypoint %s must be a readable file", entrypoint)
		}
		return entrypoint, nil
	}
	return "", errors.New("bot repository root must contain apps/bot/src/lark.ts or src/lark.ts")
}

func validateExecutable(name, path string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("%s executable must be an absolute path", name)
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("%s path must point to an executable file", name)
	}
	return nil
}

func validateWorkspaceDependencies(workspace string) error {
	manifest, err := os.ReadFile(filepath.Join(workspace, "package.json"))
	if err != nil {
		return errors.New("bot workspace must contain package.json")
	}
	var config struct {
		Dependencies map[string]json.RawMessage `json:"dependencies"`
	}
	if err := json.Unmarshal(manifest, &config); err != nil {
		return fmt.Errorf("decode bot package.json: %w", err)
	}
	var missing []string
	for name := range config.Dependencies {
		path := filepath.Join(workspace, "node_modules", filepath.FromSlash(name))
		info, err := os.Stat(path)
		if err != nil || !info.IsDir() {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return fmt.Errorf("missing bot dependencies %s. Run pnpm install from the repository root", strings.Join(missing, ", "))
	}
	return nil
}
