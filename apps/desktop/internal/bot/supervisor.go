package bot

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type State string

const (
	Stopped  State = "stopped"
	Starting State = "starting"
	Running  State = "running"
	Stopping State = "stopping"
	Failed   State = "failed"
)

var (
	ErrAlreadyActive        = errors.New("bot is already active")
	ErrTransitionInProgress = errors.New("bot lifecycle change is in progress")
)

const (
	readyLine             = "Connected to Lark via WebSocket."
	startupFailurePrefix  = "github-activity-bot startup_failed "
	defaultStartupTimeout = 60 * time.Second
	defaultStopTimeout    = 20 * time.Second
	waitDelay             = 2 * time.Second
	forceStopTimeout      = 3 * time.Second
)

type Config struct {
	NodePath       string
	WorkDir        string
	Args           []string
	Env            []string // A nil or empty slice passes an empty environment.
	Revision       string
	Log            io.Writer
	StartupTimeout time.Duration
	StopTimeout    time.Duration
}

type Snapshot struct {
	State     State
	PID       int
	StartedAt time.Time
	Revision  string
	LastError string
}

type process struct {
	cmd          *exec.Cmd
	done         chan struct{}
	startupTimer *time.Timer
	startupError string
	forced       bool
}

type Supervisor struct {
	config     Config
	log        *lockedWriter
	transition sync.Mutex
	mu         sync.Mutex
	process    *process
	snapshot   Snapshot
}

func New(config Config) *Supervisor {
	if config.Args == nil {
		config.Args = []string{"--env-file-if-exists=.env", "src/lark.ts"}
	} else {
		config.Args = append([]string(nil), config.Args...)
	}
	config.Env = append([]string{}, config.Env...)
	if config.Log == nil {
		config.Log = io.Discard
	}
	if config.StartupTimeout <= 0 {
		config.StartupTimeout = defaultStartupTimeout
	}
	if config.StopTimeout <= 0 {
		config.StopTimeout = defaultStopTimeout
	}
	return &Supervisor{
		config:   config,
		log:      &lockedWriter{output: config.Log},
		snapshot: Snapshot{State: Stopped},
	}
}

func (s *Supervisor) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshot
}

func (s *Supervisor) Start() error {
	return s.change(s.start)
}

// Stop waits for graceful Node shutdown before forcibly stopping the process.
func (s *Supervisor) Stop() error {
	return s.change(s.stop)
}

func (s *Supervisor) Restart() error {
	return s.change(func() error {
		if err := s.stop(); err != nil {
			return err
		}
		return s.start()
	})
}

func (s *Supervisor) change(work func() error) error {
	if !s.transition.TryLock() {
		return ErrTransitionInProgress
	}
	defer s.transition.Unlock()
	return work()
}

func (s *Supervisor) start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.process != nil {
		return ErrAlreadyActive
	}

	config := s.config
	if !filepath.IsAbs(config.NodePath) || !filepath.IsAbs(config.WorkDir) {
		err := errors.New("Node and bot checkout must use absolute paths")
		s.snapshot = Snapshot{State: Failed, LastError: err.Error()}
		return err
	}
	cmd := exec.Command(config.NodePath, config.Args...)
	cmd.Dir = config.WorkDir
	cmd.Env = config.Env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = waitDelay
	current := &process{cmd: cmd, done: make(chan struct{})}
	cmd.Stdout = &statusWriter{output: s.log, onLine: func(line string) { s.observeStartup(current, line) }}
	cmd.Stderr = s.log
	if err := cmd.Start(); err != nil {
		err = fmt.Errorf("start bot: %w", err)
		s.snapshot = Snapshot{State: Failed, LastError: err.Error()}
		return err
	}
	s.process = current
	s.snapshot = Snapshot{
		State: Starting, PID: cmd.Process.Pid, StartedAt: time.Now(), Revision: config.Revision,
	}
	current.startupTimer = time.AfterFunc(config.StartupTimeout, func() {
		s.expireStartup(current)
	})
	go s.wait(current)
	return nil
}

func (s *Supervisor) observeStartup(current *process, line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.process != current || s.snapshot.State != Starting {
		return
	}
	if line == readyLine && current.startupError == "" {
		current.startupTimer.Stop()
		s.snapshot.State = Running
	} else if detail := startupDiagnostic(line); detail != "" {
		current.startupError = detail
	}
}

func (s *Supervisor) expireStartup(current *process) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.process != current || s.snapshot.State != Starting {
		return
	}
	if current.startupError == "" {
		current.startupError = "Bot 启动超时。请检查飞书连接后重试。"
	}
	// At this point the child has exceeded its own connection deadline.
	if err := syscall.Kill(-current.cmd.Process.Pid, syscall.SIGKILL); err != nil {
		_ = current.cmd.Process.Kill()
	}
}

func startupDiagnostic(line string) string {
	fields, ok := strings.CutPrefix(line, startupFailurePrefix)
	if !ok {
		return ""
	}
	switch fields {
	case "lark not_connected", "lark send_timeout":
		return "飞书连接超时。请检查网络和应用配置。"
	case "lark permission_denied":
		return "飞书拒绝连接。请检查应用权限。"
	case "lark rate_limited":
		return "飞书连接已被限流。请稍后重试。"
	case "lark unknown":
		return "飞书连接失败。请检查网络和应用配置。"
	case "webhook EADDRINUSE":
		return "GitHub Webhook 端口已被占用。请在设置中修改端口。"
	case "webhook EACCES", "webhook EPERM", "webhook EADDRNOTAVAIL", "webhook unknown":
		return "GitHub Webhook 无法监听。请检查端口设置。"
	case "configuration invalid_configuration":
		return "Bot 配置有误。请检查设置，或在终端启动查看配置提示。"
	case "bot unknown":
		return "Bot 初始化失败。请检查运行环境和本地数据目录。"
	}
	return ""
}

func (s *Supervisor) wait(current *process) {
	err := current.cmd.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	current.startupTimer.Stop()
	switch {
	case s.snapshot.State == Stopping && current.forced:
		s.snapshot = Snapshot{State: Stopped, LastError: "Bot needed a forced stop."}
	case s.snapshot.State == Stopping:
		s.snapshot = Snapshot{State: Stopped}
	default:
		message := current.startupError
		if message == "" {
			message = "Bot exited unexpectedly."
			if err != nil {
				message = fmt.Sprintf("Bot exited unexpectedly: %v", err)
			}
		}
		s.snapshot = Snapshot{
			State: Failed, StartedAt: s.snapshot.StartedAt, Revision: s.snapshot.Revision, LastError: message,
		}
	}
	s.process = nil
	close(current.done)
}

func (s *Supervisor) stop() error {
	s.mu.Lock()
	current := s.process
	if current == nil {
		s.snapshot = Snapshot{State: Stopped}
		s.mu.Unlock()
		return nil
	}
	s.snapshot.State = Stopping
	s.mu.Unlock()

	// Send TERM to Node itself. It closes the Lark connection, flushes SQLite
	// work, and disposes the Codex processes it owns.
	err := current.cmd.Process.Signal(syscall.SIGTERM)
	if (err == nil || errors.Is(err, os.ErrProcessDone)) && completedWithin(current.done, s.config.StopTimeout) {
		return nil
	}
	return s.forceStop(current)
}

func (s *Supervisor) forceStop(current *process) error {
	s.mu.Lock()
	if s.process != current {
		s.mu.Unlock()
		return nil
	}
	current.forced = true
	// Only the fallback stops the whole group, which can still hold open log
	// pipes if Node was unable to shut down its children.
	err := syscall.Kill(-current.cmd.Process.Pid, syscall.SIGKILL)
	s.mu.Unlock()
	if err != nil && !errors.Is(err, syscall.ESRCH) {
		if killErr := current.cmd.Process.Kill(); killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
			return s.stopFailure(current, fmt.Errorf("force stop bot: %w", killErr))
		}
	}
	if completedWithin(current.done, forceStopTimeout) {
		return nil
	}
	return s.stopFailure(current, errors.New("bot did not exit after a forced stop"))
}

func (s *Supervisor) stopFailure(current *process, err error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.process != current {
		return nil
	}
	s.snapshot.LastError = err.Error()
	return err
}

func completedWithin(done <-chan struct{}, timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

type lockedWriter struct {
	mu     sync.Mutex
	output io.Writer
}

func (w *lockedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	// A log sink error must not close the bot's stdout or stderr.
	_, _ = w.output.Write(p)
	return len(p), nil
}

type statusWriter struct {
	output   io.Writer
	onLine   func(string)
	line     []byte
	overflow bool
}

func (w *statusWriter) Write(p []byte) (int, error) {
	n, err := w.output.Write(p)
	for p = p[:n]; len(p) > 0; {
		line, rest, terminated := bytes.Cut(p, []byte{'\n'})
		if !w.overflow {
			if len(w.line)+len(line) > 128 {
				w.overflow = true
			} else {
				w.line = append(w.line, line...)
			}
		}
		if !terminated {
			break
		}
		if !w.overflow {
			w.onLine(string(bytes.TrimSuffix(w.line, []byte{'\r'})))
		}
		w.line = w.line[:0]
		w.overflow = false
		p = rest
	}
	return n, err
}
