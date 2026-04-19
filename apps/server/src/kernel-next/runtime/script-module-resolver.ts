// Script module resolver — userland extension point for script stages.
//
// ScriptStage.config declares a `moduleId: string`. The kernel does not
// import arbitrary modules itself; instead it asks a userland-supplied
// resolver to hand back a ScriptModule for the given id. This mirrors
// the prompt-resolver split (see prompt-resolver.ts): the kernel owns
// lifecycle + lineage, userland owns the concrete work.
//
// For A1.1 we ship only the trivial in-process resolver: a plain map
// from moduleId to a callable. A future dynamic-import variant can
// implement the same interface without any kernel changes.

/**
 * A ScriptModule is the unit of work a script stage runs. `inputs` is a
 * record of port values keyed by the stage's input port names; the
 * returned object's keys that match declared output ports are persisted
 * via PortRuntime.writePort (any extra keys are ignored, same stance as
 * mock-executor).
 *
 * The callable may be synchronous or async; the kernel awaits regardless.
 */
export interface ScriptModule {
  run(
    inputs: Record<string, unknown>,
    ctx: ScriptModuleContext,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface ScriptModuleContext {
  taskId: string;
  stageName: string;
  attemptId: string;
  attemptIdx: number;
  moduleId: string;
}

export interface ScriptModuleResolver {
  resolve(moduleId: string): ScriptModule | undefined;
}

/**
 * In-process resolver backed by an explicit map. Callers construct it
 * with the modules they wish to expose; moduleIds not in the map
 * resolve to `undefined` (the executor then raises SCRIPT_MODULE_MISSING).
 */
export class TrivialScriptModuleResolver implements ScriptModuleResolver {
  private readonly modules: Record<string, ScriptModule>;

  constructor(options: { modules: Record<string, ScriptModule> }) {
    this.modules = { ...options.modules };
  }

  resolve(moduleId: string): ScriptModule | undefined {
    return this.modules[moduleId];
  }
}
