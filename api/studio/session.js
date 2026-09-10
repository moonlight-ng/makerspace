import {
    applyStudioSecurityHeaders,
    clearStudioSessionCookie,
    getStudioSession,
} from '../../server/studio-auth.js';
import { handleError, requireMethod, sendJson } from '../../server/http.js';

export default async function handler(request, response) {
    applyStudioSecurityHeaders(response);
    try {
        requireMethod(request, 'GET');
        const session = getStudioSession(request);
        if (!session) {
            response.setHeader('Set-Cookie', clearStudioSessionCookie());
            return sendJson(response, 200, { authenticated: false });
        }
        return sendJson(response, 200, {
            authenticated: true,
            email: session.email,
            expiresAt: new Date(session.expiresAt * 1_000).toISOString(),
        });
    } catch (error) {
        handleError(response, error);
    }
}
