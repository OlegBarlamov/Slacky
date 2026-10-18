import type { Id } from '../../../shared/types';

export type Body = Record<string, unknown> | undefined;
export type IdParams = { Params: { id: Id } };
export type IdBody = { Params: { id: Id }; Body: Body };
