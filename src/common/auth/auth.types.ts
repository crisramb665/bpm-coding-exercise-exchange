export type Role = 'USER' | 'COMPLIANCE';

export interface AuthUser {
  id: string;
  role: Role;
  name: string;
}

// Lo mínimo que se usa de la petición HTTP (evita depender de los tipos de express).
export interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}
