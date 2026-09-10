import { handleError, queryValue, requireMethod, sendJson } from '../../server/http.js';
import { applyStudioSecurityHeaders, requireStudioSession } from '../../server/studio-auth.js';
import { listStudioOrders } from '../../server/studio-orders.js';

export default async function handler(request, response) {
    applyStudioSecurityHeaders(response);
    try {
        requireMethod(request, 'GET');
        requireStudioSession(request);
        const orders = await listStudioOrders({
            q: queryValue(request, 'q'),
            status: queryValue(request, 'status'),
            environment: queryValue(request, 'environment'),
            limit: queryValue(request, 'limit'),
            offset: queryValue(request, 'offset'),
        });
        sendJson(response, 200, orders);
    } catch (error) {
        handleError(response, error);
    }
}
