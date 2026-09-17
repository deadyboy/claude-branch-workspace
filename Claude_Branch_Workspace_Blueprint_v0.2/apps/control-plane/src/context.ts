// AppContext: the control plane's shared application wiring (S5). One place
// owns every collaborator the routes / ws / entrypoint need; buildApp receives
// these explicitly (injectable for hermetic tests).

export interface AppContext {
  db: unknown;
  svc: import("@cbw/domain").DomainService;
  repo: import("@cbw/domain").Repository;
  bus: import("@cbw/event-protocol").EventBus;
  sessionManager: import("./session-manager.js").SessionManager;
  forkOrchestrator: import("./fork-orchestrator.js").ForkOrchestrator;
  attention: import("./attention-registry.js").AttentionRegistry;
  adapter: import("@cbw/runtime").RuntimeAdapter;
  /** Present only when CBW_FAKE_RUNTIME=1 (S7 E2E / hermetic tests). */
  fakeAdapter?: import("@cbw/runtime").RuntimeAdapter;
}
