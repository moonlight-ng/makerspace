import {
    applyStudioSecurityHeaders,
    clearStudioSessionCookie,
} from '../../../server/studio-auth.js';
import { handleError, requireMethod, sendJson } from '../../../server/http.js';

export default async function handler(request, response) {
    applyStudioSecurityHeaders(response);
    try {
        requireMethod(request, 'POST');
        response.setHeader('Set-Cookie', clearStudioSessionCookie());
        sendJson(response, 200, { authenticated: false });
    } catch (error) {
        handleError(response, error);
    }
}
