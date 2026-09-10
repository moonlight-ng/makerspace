import {
    applyStudioSecurityHeaders,
    studioSessionCookie,
    verifyStudioCode,
} from '../../../server/studio-auth.js';
import { handleError, readJson, requireMethod, sendJson } from '../../../server/http.js';

export default async function handler(request, response) {
    applyStudioSecurityHeaders(response);
    try {
        requireMethod(request, 'POST');
        const session = await verifyStudioCode(await readJson(request));
        response.setHeader('Set-Cookie', studioSessionCookie(session.token));
        sendJson(response, 200, { authenticated: true, email: session.email });
    } catch (error) {
        handleError(response, error);
    }
}
