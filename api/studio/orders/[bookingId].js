import { handleError, requireMethod, sendJson } from '../../../server/http.js';
import { applyStudioSecurityHeaders, requireStudioSession } from '../../../server/studio-auth.js';
import { getStudioOrder } from '../../../server/studio-orders.js';

function bookingIdFromRequest(request) {
    const queryId = request.query?.bookingId;
    if (Array.isArray(queryId)) return queryId[0];
    if (queryId) return queryId;
    const path = new URL(request.url, 'http://localhost').pathname.split('/').filter(Boolean);
    return path[path.length - 1];
}

export default async function handler(request, response) {
    applyStudioSecurityHeaders(response);
    try {
        requireMethod(request, 'GET');
        requireStudioSession(request);
        sendJson(response, 200, await getStudioOrder(bookingIdFromRequest(request)));
    } catch (error) {
        handleError(response, error);
    }
}
