import { AppError } from '../../server/errors.js';
import { handleError, requireMethod, sendJson } from '../../server/http.js';
import { syncPendingNotionBookings } from '../../server/notion.js';

export const config = {
    maxDuration: 60,
};

export default async function handler(request, response) {
    try {
        requireMethod(request, 'GET');

        const cronSecret = String(process.env.CRON_SECRET || '').trim();
        if (!cronSecret || request.headers.authorization !== `Bearer ${cronSecret}`) {
            throw new AppError('Unauthorized.', 401, 'unauthorized');
        }

        const result = await syncPendingNotionBookings({ limit: 10 });
        if (!result.configured) {
            throw new AppError('Notion sync is not configured.', 503, 'configuration_error');
        }
        if (result.failed > 0) {
            throw new AppError(
                `${result.failed} booking record${result.failed === 1 ? '' : 's'} remain queued for Notion.`,
                503,
                'notion_sync_incomplete',
            );
        }

        sendJson(response, 200, result);
    } catch (error) {
        handleError(response, error);
    }
}
