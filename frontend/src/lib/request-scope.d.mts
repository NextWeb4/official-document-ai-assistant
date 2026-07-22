export interface RequestScopeToken<Key extends string> {
  readonly key: Key;
  readonly generation: number;
}

export interface RequestScope<Key extends string> {
  capture(): RequestScopeToken<Key>;
  advance(nextKey: Key): void;
  isCurrent(token: RequestScopeToken<Key>): boolean;
}

export function createRequestScope<Key extends string>(initialKey: Key): RequestScope<Key>;
