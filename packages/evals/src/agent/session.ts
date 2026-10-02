// Child-process entry: runs one case's conversation through pi, configured the
// way the desktop agent host configures it (packages/desktop/src/main/agent/
// host/runtime.ts): no discovered resources, our system.md, the bundled
// extension, the default plugin's skills. One process per case because the
// extension reads ACCOUNTANT24_WORKSPACE once, at load.
//
//   tsx session.ts <job.json>   → writes job.outFile

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { PreparedTurn } from "../workspace";
import { askedInsteadOfActing } from "./ask";

export type SessionJob = {
  workspace: string;
  /** Holds pi's auth/models files, outside the workspace. */
  agentDir: string;
  provider: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  extensionPath: string;
  systemPromptPath: string;
  /** Skill folders with their plugin-namespaced `<plugin>:<skill>` names, as the desktop loads them. */
  skills: { path: string; name: string }[];
  turns: PreparedTurn[];
  /** Sent once after the last scripted turn if the agent stopped to ask. */
  autoReply: string;
  outFile: string;
};

export type SessionOutput = {
  systemPrompt: string;
  messages: unknown[];
  autoReplied: boolean;
};

async function main(): Promise<void> {
  const job = JSON.parse(readFileSync(process.argv[2], "utf8")) as SessionJob;
  const modelRuntime = await ModelRuntime.create({
    authPath: join(job.agentDir, "auth.json"),
    modelsPath: join(job.agentDir, "models.json"),
    modelsStore: new InMemoryModelsStore(),
  });
  const model = modelRuntime.getModel(job.provider, job.model);
  if (!model) throw new Error(`unknown model ${job.provider}/${job.model}`);

  const nameBySkillDir = new Map(job.skills.map((skill) => [skill.path, skill.name]));
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        systemPrompt: job.systemPromptPath,
        additionalSkillPaths: job.skills.map((skill) => skill.path),
        skillsOverride: (base) => ({
          ...base,
          skills: base.skills.map((skill) => {
            const name = nameBySkillDir.get(skill.baseDir);
            return name ? { ...skill, name } : skill;
          }),
        }),
        additionalExtensionPaths: [job.extensionPath],
      },
    });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, {
    cwd: job.workspace,
    agentDir: job.workspace,
    sessionManager: SessionManager.open(
      join(job.workspace, "sessions", "eval.jsonl"),
      join(job.workspace, "sessions"),
      job.workspace,
    ),
  });
  const session = runtime.session;
  await session.bindExtensions({
    uiContext: headlessUi(),
    mode: "rpc",
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle(),
      reload: async () => {},
      navigateTree: async () => ({ cancelled: true }),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
    },
    onError: (err) => {
      throw new Error(`extension error in ${err.event}: ${err.error}`);
    },
  });
  await session.setModel(model);
  session.setThinkingLevel(job.thinking);

  for (const turn of job.turns) {
    await session.prompt(turn.text, turn.images.length ? { images: turn.images } : undefined);
  }
  let autoReplied = false;
  const before = session.messages.length;
  const lastTurnStart = session.messages.findLastIndex((m) => m.role === "user");
  if (askedInsteadOfActing(session.messages.slice(lastTurnStart) as never)) {
    await session.prompt(job.autoReply);
    autoReplied = session.messages.length > before;
  }

  const output: SessionOutput = {
    systemPrompt: session.agent.state.systemPrompt,
    messages: session.messages,
    autoReplied,
  };
  writeFileSync(job.outFile, JSON.stringify(output));
  session.dispose();
}

/** Non-interactive UI: dialogs resolve to their defaults at once, display calls do nothing.
 *  Nothing in our extension uses it; it keeps a skill that does from hanging the run. */
function headlessUi(): ExtensionUIContext {
  const noop = () => {};
  const context = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    notify: noop,
    setStatus: noop,
    setWidget: noop,
    setTitle: noop,
    setEditorText: noop,
    pasteToEditor: noop,
    getEditorText: () => "",
    onTerminalInput: () => noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setFooter: noop,
    setHeader: noop,
    custom: async () => undefined,
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "headless" }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  };
  return context as unknown as ExtensionUIContext;
}

if (process.argv[1]?.endsWith("session.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
}
