/**
 * Ambient types for the DeepSeek Harness services this plugin consumes.
 *
 * The published `@deepseek-ai/dsh` runtime is large, so it is not a dev
 * dependency; these declarations keep `tsc --checkJs` useful without pulling
 * the whole Host into the repository. They are intentionally loose: the real
 * service contracts are exercised by the Host smoke test and the e2e suite.
 */

import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence?: any
    sessionQuery?: any
    workspaceRegistry?: any
    sessionController?: any
    sessions?: any
    agents?: any
    webServer?: any
    connection?: any
    timer?: any
    remoteAccess?: any
    interval?: any
    timeout?: any
    waterfall(name: string, ...args: any[]): Promise<any>
    emit(event: string, ...args: any[]): void
  }
}

declare module '@deepseek-ai/dsh-session-persistence' {
  export interface SessionPersistence {
    stat(sessionId: string): Promise<any>
    list(): Promise<any[]>
  }
  export interface SessionSnapshot {
    header: any
    formatStatus: string
    location: { kind: string; path: string }
  }
}
