import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './logger.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Run AppleScript via stdin (avoids all shell escaping issues)
function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', []);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `osascript exited with code ${code}`));
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

// ── Active project cache ─────────────────────────────────────────────────────
// Base directory where WebStorm projects live (parent of cwd)
const PROJECTS_BASE = dirname(process.cwd());

let activeProject = { name: null, path: null, screenSession: null };

// ── run_claude debounce ──────────────────────────────────────────────────────
const RUN_CLAUDE_DEBOUNCE_MS = 2000;
let lastRunClaudeTime = 0;

function resolveProjectPath(windowTitle) {
  // WebStorm titles: "project-name – file.js" or just "project-name"
  const projectName = windowTitle.split(' – ')[0].trim();
  const candidate = join(PROJECTS_BASE, projectName);
  if (existsSync(candidate)) {
    return { name: projectName, path: candidate };
  }
  return { name: projectName, path: null };
}

export function getActiveProject() {
  return activeProject;
}

export function setActiveProject(name, path, screenSession) {
  activeProject = { name, path, screenSession: screenSession || null };
  logger.info({ activeProject }, 'Active project updated');
}

// Register your server-side tools (function calling) here.
// Each tool: { definition, handler }

export const tools = [
  {
    definition: {
      type: 'function',
      name: 'switch_active_project',
      description:
        'Переключает активный проект. Вызывай ТОЛЬКО когда пользователь явно просит сменить проект: "переключись на проект X", "смени проект", "перейди на X", "открой проект X". НЕ вызывай, если пользователь просто упоминает название проекта в контексте задачи — это для run_claude.',
      parameters: {
        type: 'object',
        properties: {
          project_name: {
            type: 'string',
            description: 'Full or partial project name to switch to',
          },
        },
        required: ['project_name'],
      },
    },
    handler: async ({ project_name }) => {
      try {
        const projects = await detectProjects();

        if (projects.length === 0) {
          return { success: false, error: 'No WebStorm projects detected' };
        }

        const query = project_name.toLowerCase();
        const target = projects.find((p) => p.name.toLowerCase().includes(query));

        if (!target) {
          const names = projects.map((p) => p.name).join(', ');
          return {
            success: false,
            error: `Project "${project_name}" not found. Available: ${names}`,
          };
        }

        // Switch WebStorm window
        const safeTitle = target.window.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        await execAsync(
          `osascript -e 'tell application "System Events" to tell process "WebStorm"
            set frontmost to true
            perform action "AXRaise" of (first window whose name contains "${safeTitle}")
          end tell'`,
        );

        // Update active project on server
        activeProject = { name: target.name, path: target.path, screenSession: target.screenSession };
        logger.info({ activeProject }, 'Active project switched via voice');

        return {
          success: true,
          project: target.name,
          hasClaude: target.hasClaude,
          silent: true,
        };
      } catch (err) {
        logger.error({ project_name, err: err.message }, 'Failed to switch active project');
        return { success: false, error: err.message, silent: true };
      }
    },
  },
  {
    definition: {
      type: 'function',
      name: 'set_effort',
      description:
        'Меняет уровень effort в Claude Code. Вызывай ТОЛЬКО когда пользователь явно говорит про effort/усилие: "effort max", "поставь effort high", "усилие на максимум", "минимальный режим", "поставь авто". НЕ вызывай для любых других настроек.',
      parameters: {
        type: 'object',
        properties: {
          level: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'max', 'auto'],
            description: 'low = minimal, medium = balanced, high = thorough, max = maximum capability, auto = let Claude decide',
          },
        },
        required: ['level'],
      },
    },
    handler: async ({ level }) => {
      const session = activeProject.screenSession;
      if (!session) {
        return { success: false, error: 'No screen session found for active project.', silent: true };
      }

      logger.info({ level, session }, 'Setting Claude Code effort level');

      try {
        await execAsync(`screen -S ${session} -X stuff $'/effort ${level}\\r'`);
        logger.info({ level, session }, 'Effort level set');
        return { success: true, level, silent: true };
      } catch (err) {
        logger.error({ level, session, err: err.message }, 'Failed to set effort level');
        return { success: false, error: err.message, silent: true };
      }
    },
  },
  {
    definition: {
      type: 'function',
      name: 'toggle_mode',
      description:
        'Переключает режим Claude Code (план/обычный) нажатием Shift+Tab. Вызывай ТОЛЬКО когда пользователь явно просит сменить режим: "план мод", "plan mode", "переключи режим", "режим планирования", "выйди из плана". НЕ вызывай, если пользователь просто говорит о планах в контексте задачи.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => {
      const session = activeProject.screenSession;
      if (!session) {
        return { success: false, error: 'No screen session found for active project.', silent: true };
      }

      logger.info({ session }, 'Toggling Claude Code mode (Shift+Tab)');

      try {
        await execAsync(`screen -S ${session} -X stuff $'\\033[Z'`);
        logger.info({ session }, 'Shift+Tab sent to Claude Code');
        return { success: true, silent: true };
      } catch (err) {
        logger.error({ session, err: err.message }, 'Failed to toggle mode');
        return { success: false, error: err.message, silent: true };
      }
    },
  },
  {
    definition: {
      type: 'function',
      name: 'run_claude',
      description:
        'ИНСТРУМЕНТ ПО УМОЛЧАНИЮ. Передаёт речь пользователя дословно в Claude Code. Вызывай для ВСЕГО, что не подходит под другие инструменты: любые задачи, вопросы, просьбы написать код, исправить баг, объяснить, создать файл и т.д. Передавай слова пользователя КАК ЕСТЬ, без перефразирования.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The task or question to send to Claude Code (be detailed and specific)',
          },
        },
        required: ['prompt'],
      },
    },
    handler: async ({ prompt }) => {
      const now = Date.now();
      if (now - lastRunClaudeTime < RUN_CLAUDE_DEBOUNCE_MS) {
        logger.warn({ prompt, gap: now - lastRunClaudeTime }, 'run_claude debounced');
        return { success: false, error: 'Debounced — too soon after previous call', silent: true };
      }
      lastRunClaudeTime = now;

      const session = activeProject.screenSession;
      if (!session) {
        logger.error('No screen session for active project');
        return { success: false, error: 'No screen session found for active project. Select a project with Claude first.', silent: true };
      }

      logger.info({ prompt, session }, 'Sending to Claude Code via screen');

      try {
        await execAsync(`screen -S ${session} -X stuff $'${prompt.replace(/'/g, "'\\''")}\r'`);
        logger.info({ prompt, session }, 'Sent to Claude Code');
        return { success: true, silent: true };
      } catch (err) {
        logger.error({ prompt, session, err: err.message }, 'Failed to send to Claude Code');
        return { success: false, error: err.message, silent: true };
      }
    },
  },
  {
    definition: {
      type: 'function',
      name: 'confirm_claude',
      description:
        'Нажимает Enter для подтверждения запроса разрешения в Claude Code. Вызывай ТОЛЬКО для коротких односложных подтверждений: "да", "подтверди", "давай", "окей", "принять", "разрешить", "yes", "confirm". НЕ вызывай, если после "да" идёт продолжение фразы с задачей — это для run_claude.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => {
      const session = activeProject.screenSession;
      if (!session) {
        return { success: false, error: 'No screen session found for active project.', silent: true };
      }

      logger.info({ session }, 'Confirming Claude Code action');

      try {
        await execAsync(`screen -S ${session} -X stuff $'\\r'`);
        logger.info({ session }, 'Enter sent to Claude Code');
        return { success: true, silent: true };
      } catch (err) {
        logger.error({ session, err: err.message }, 'Failed to confirm Claude Code');
        return { success: false, error: err.message, silent: true };
      }
    },
  },
  {
    definition: {
      type: 'function',
      name: 'interrupt_claude',
      description:
        'Прерывает текущую задачу Claude Code нажатием Escape. Вызывай ТОЛЬКО для явных команд остановки: "стоп", "прерви", "хватит", "отмена", "остановись", "stop", "cancel". НЕ вызывай, если пользователь говорит "стоп" в контексте задачи (например, "останови сервер") — это для run_claude.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => {
      const session = activeProject.screenSession;
      if (!session) {
        return { success: false, error: 'No screen session found for active project.', silent: true };
      }

      logger.info({ session }, 'Rejecting (Escape) Claude Code task');

      try {
        await execAsync(`screen -S ${session} -X stuff $'\\033'`);
        logger.info({ session }, 'Escape sent to Claude Code');
        return { success: true, silent: true };
      } catch (err) {
        logger.error({ session, err: err.message }, 'Failed to reject Claude Code');
        return { success: false, error: err.message, silent: true };
      }
    },
  },
];

// ── Detect open WebStorm projects & Claude terminals ────────────────────────

async function getClaudeScreenMap() {
  // Returns Map<cwd, screenSessionId> by walking screen → shell → claude process tree
  const map = new Map();
  try {
    const { stdout } = await execAsync('screen -ls 2>&1 || true');
    const re = /(\d+)\.(claude\S*)\s+\((Attached|Detached)\)/g;
    let m;
    while ((m = re.exec(stdout)) !== null) {
      const screenPid = m[1];
      const sessionId = `${m[1]}.${m[2]}`;
      const attached = m[3] === 'Attached';

      try {
        // screen → shell → claude
        const { stdout: children } = await execAsync(`pgrep -P ${screenPid} 2>/dev/null`);
        for (const childPid of children.trim().split('\n').filter(Boolean)) {
          const gcResult = await execAsync(`pgrep -P ${childPid} 2>/dev/null`).catch(() => ({ stdout: '' }));
          for (const gpid of gcResult.stdout.trim().split('\n').filter(Boolean)) {
            const lsofResult = await execAsync(
              `lsof -a -p ${gpid} -d cwd -Fn 2>/dev/null`,
            ).catch(() => ({ stdout: '' }));
            const cwdLine = lsofResult.stdout.split('\n').find((l) => l.startsWith('n/'));
            if (cwdLine) {
              const cwd = cwdLine.slice(1);
              // Prefer attached sessions over detached
              if (!map.has(cwd) || attached) {
                map.set(cwd, sessionId);
              }
            }
          }
        }
      } catch {
        // screen session may have exited
      }
    }
  } catch {
    // no screen sessions
  }
  return map;
}

export async function detectProjects() {
  const projects = [];

  // Run both in parallel
  let windows = [];
  let screenMap = new Map();

  try {
    const [windowsResult, mapResult] = await Promise.allSettled([
      execAsync(
        `osascript -e 'tell application "System Events" to tell process "WebStorm" to get name of every window'`,
      ),
      getClaudeScreenMap(),
    ]);

    if (windowsResult.status === 'fulfilled') {
      windows = windowsResult.value.stdout.trim().split(', ').filter(Boolean);
    } else {
      logger.warn({ err: windowsResult.reason?.message }, 'Failed to get WebStorm windows (not running?)');
    }

    if (mapResult.status === 'fulfilled') {
      screenMap = mapResult.value;
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to detect projects');
    return projects;
  }

  for (const win of windows) {
    const resolved = resolveProjectPath(win);
    if (!resolved.name) continue;

    let hasClaude = false;
    let screenSession = null;

    for (const [cwd, session] of screenMap) {
      // Exact match or subdirectory of known project path
      if (resolved.path && (cwd === resolved.path || cwd.startsWith(resolved.path + '/'))) {
        hasClaude = true;
        screenSession = session;
        break;
      }
      // Fallback: match by project name as last directory component in CWD
      // Handles nested projects like /WebstormProjects/org/backend-main
      if (!resolved.path && cwd.split('/').pop() === resolved.name) {
        hasClaude = true;
        screenSession = session;
        resolved.path = cwd;
        break;
      }
    }

    projects.push({
      name: resolved.name,
      path: resolved.path,
      window: win,
      hasClaude,
      screenSession,
    });
  }

  return projects;
}

const handlerMap = new Map(tools.map((t) => [t.name ?? t.definition.name, t.handler]));

export async function executeTool(name, args) {
  const handler = handlerMap.get(name);
  if (!handler) {
    logger.warn({ name }, 'Unknown tool called');
    return { error: `Unknown tool: ${name}` };
  }
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    const result = await handler(parsed);
    logger.info({ name }, 'Tool executed');
    return result;
  } catch (err) {
    logger.error({ name, err: err.message }, 'Tool execution failed');
    return { error: err.message };
  }
}

export function getToolDefinitions() {
  return tools.map((t) => t.definition);
}
