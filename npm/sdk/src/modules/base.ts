import { fetchJson, joinRest, RestRequestInit, withQuery } from "../rest.js";

export abstract class BaseModule {
  constructor(private readonly restEndpoint?: string) {}

  protected ensureRest(): string {
    if (!this.restEndpoint) throw new Error("REST endpoint is not configured on LumenClient");
    return this.restEndpoint;
  }

  protected async get(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
    init?: RestRequestInit,
  ) {
    const base = this.ensureRest();
    const url = withQuery(joinRest(base, path), query);
    return fetchJson(url, init);
  }
}
