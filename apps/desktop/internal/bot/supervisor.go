package bot

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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
	readyLine          = "Connected to Lark via WebSocket."
	defaultStopTimeout = 20 * time.Second
	waitDelay          = 2 * time.Second
	forceStopTimeout   = 3 * time.Second
)

type Config struct {
	NodePath    string
	WorkDir     string
	Args        []string
	Env         []string // A nil or empty slice passes an empty environment.
	Log         io.Writer
	StopTimeout time.Duration
}

type Snapshot struct {
	State     State
	PID       int
	StartedAt time.Time
	LastError string
}

type process struct {
	cmd    *exec.Cmd
	done   chan struct{}
	forced bool
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
	cmd.Stdout = &readyWriter{output: s.log, onReady: func() { s.ready(current) }}
	cmd.Stderr = s.log
	if err := cmd.Start(); err != nil {
		err = fmt.Errorf("start bot: %w", err)
		s.snapshot = Snapshot{State: Failed, LastError: err.Error()}
		return err
	}
	s.process = current
	s.snapshot = Snapshot{State: Starting, PID: cmd.Process.Pid, StartedAt: time.Now()}
	go s.wait(current)
	return nil
}

func (s *Supervisor) ready(current *process) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.process == current && s.snapshot.State == Starting {
		s.snapshot.State = Running
	}
}

func (s *Supervisor) wait(current *process) {
	err := current.cmd.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.snapshot.State == Stopping && current.forced:
		s.snapshot = Snapshot{State: Stopped, LastError: "Bot needed a forced stop."}
	case s.snapshot.State == Stopping:
		s.snapshot = Snapshot{State: Stopped}
	default:
		message := "Bot exited unexpectedly."
		if err != nil {
			message = fmt.Sprintf("Bot exited unexpectedly: %v", err)
		}
		s.snapshot = Snapshot{State: Failed, StartedAt: s.snapshot.StartedAt, LastError: message}
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

type readyWriter struct {
	output   io.Writer
	onReady  func()
	line     []byte
	overflow bool
}

func (w *readyWriter) Write(p []byte) (int, error) {
	n, err := w.output.Write(p)
	for p = p[:n]; len(p) > 0 && w.onReady != nil; {
		line, rest, terminated := bytes.Cut(p, []byte{'\n'})
		if !w.overflow {
			if len(w.line)+len(line) > len(readyLine)+1 {
				w.overflow = true
			} else {
				w.line = append(w.line, line...)
			}
		}
		if !terminated {
			break
		}
		if !w.overflow && string(bytes.TrimSuffix(w.line, []byte{'\r'})) == readyLine {
			w.onReady()
			w.onReady = nil
		}
		w.line = w.line[:0]
		w.overflow = false
		p = rest
	}
	return n, err
}
