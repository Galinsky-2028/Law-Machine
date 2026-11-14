import { logout } from '../../../lib/server/auth.ts';
export async function POST(request: Request) { return logout(request); }
