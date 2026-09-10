import { applyStudioSecurityHeaders, requestStudioCode } from '../../../server/studio-auth.js';
import { handleError, readJson, requireMethod, sendJson } from '../../../server/http.js';

export default async function handler(request, response) {
    applyStudioSecurityHeaders(response);
    try {
        requireMethod(request, 'POST');
        await requestStudioCode(await readJson(request));
        sendJson(response, 202, {
            accepted: true,
            message: 'If this email is approved, a login code is on its way.',
        });
    } catch (error) {
        handleError(response, error);
    }
}
