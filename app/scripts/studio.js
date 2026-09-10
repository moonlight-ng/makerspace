(() => {
    const PAGE_SIZE = 30;
    const authView = document.getElementById('studio-auth');
    const dashboard = document.getElementById('studio-dashboard');
    const account = document.getElementById('studio-account');
    const accountEmail = document.getElementById('studio-account-email');
    const emailForm = document.getElementById('studio-email-form');
    const codeForm = document.getElementById('studio-code-form');
    const emailInput = document.getElementById('studio-email');
    const codeInput = document.getElementById('studio-code');
    const codeEmail = document.getElementById('studio-code-email');
    const authStatus = document.getElementById('studio-auth-status');
    const resendButton = document.getElementById('studio-resend');
    const logoutButton = document.getElementById('studio-logout');
    const searchInput = document.getElementById('studio-search');
    const statusFilter = document.getElementById('studio-status-filter');
    const environmentFilter = document.getElementById('studio-environment-filter');
    const listFrame = document.getElementById('studio-list-frame');
    const listState = document.getElementById('studio-list-state');
    const ordersBody = document.getElementById('studio-orders-body');
    const orderCount = document.getElementById('studio-order-count');
    const loadMore = document.getElementById('studio-load-more');
    const panelLayer = document.getElementById('studio-panel-layer');
    const panel = document.getElementById('studio-order-panel');
    const panelTitle = document.getElementById('studio-order-title');
    const panelStatus = document.getElementById('studio-panel-status');
    const panelContent = document.getElementById('studio-panel-content');
    const paystackLink = document.getElementById('studio-paystack-link');
    const copyReference = document.getElementById('studio-copy-reference');

    let loginEmail = '';
    let resendSeconds = 0;
    let resendTimer = null;
    let searchTimer = null;
    let orders = [];
    let total = 0;
    let loadingOrders = false;
    let listError = '';
    let listRequest = null;
    let lastFocused = null;
    let activeOrder = null;

    const request = async (url, options = {}) => {
        const { headers = {}, ...requestOptions } = options;
        const response = await fetch(url, {
            credentials: 'same-origin',
            ...requestOptions,
            headers: { Accept: 'application/json', ...headers },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error || 'Something went wrong. Please try again.');
            error.status = response.status;
            error.code = payload.code;
            throw error;
        }
        return payload;
    };

    const postJson = (url, body) => request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });

    const titleCase = (value) => {
        const text = String(value || '—').replaceAll('_', ' ');
        return text === '—' ? text : `${text[0].toUpperCase()}${text.slice(1)}`;
    };

    const formatAmount = (amount, currency = 'NGN') => new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
    }).format(Number(amount || 0) / 100);

    const formatDate = (value, withTime = true) => {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '—';
        return new Intl.DateTimeFormat('en-NG', {
            dateStyle: 'medium',
            ...(withTime ? { timeStyle: 'short' } : {}),
            timeZone: 'Africa/Lagos',
        }).format(date);
    };

    const formatSession = (date, period) => {
        const parsed = new Date(`${date}T12:00:00Z`);
        const formatted = Number.isNaN(parsed.getTime()) ? date : new Intl.DateTimeFormat('en-NG', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(parsed);
        return `${formatted} · ${titleCase(period)}`;
    };

    const setButtonBusy = (button, busy, label) => {
        if (!button.dataset.label) button.dataset.label = button.textContent;
        button.disabled = busy;
        button.textContent = busy ? label : button.dataset.label;
    };

    function setAuthState(state) {
        authStatus.textContent = '';
        if (state === 'email') {
            emailForm.hidden = false;
            codeForm.hidden = true;
            codeInput.value = '';
            window.setTimeout(() => emailInput.focus(), 0);
            return;
        }
        emailForm.hidden = true;
        codeForm.hidden = false;
        codeEmail.textContent = loginEmail;
        window.setTimeout(() => codeInput.focus(), 0);
    }

    function showLogin() {
        closeOrder({ updateUrl: true, restoreFocus: false });
        authView.hidden = false;
        dashboard.hidden = true;
        account.hidden = true;
        accountEmail.textContent = '';
        orders = [];
        ordersBody.replaceChildren();
        setAuthState('email');
    }

    async function showDashboard(email) {
        authView.hidden = true;
        dashboard.hidden = false;
        account.hidden = false;
        accountEmail.textContent = email;
        await loadOrders({ reset: true });
        const selectedId = new URL(window.location.href).searchParams.get('order');
        if (selectedId) openOrder(selectedId, { updateUrl: false });
    }

    function startResendCountdown() {
        window.clearInterval(resendTimer);
        resendSeconds = 60;
        resendButton.disabled = true;
        resendButton.textContent = `Resend in ${resendSeconds}s`;
        resendTimer = window.setInterval(() => {
            resendSeconds -= 1;
            if (resendSeconds <= 0) {
                window.clearInterval(resendTimer);
                resendButton.disabled = false;
                resendButton.textContent = 'Resend code';
            } else {
                resendButton.textContent = `Resend in ${resendSeconds}s`;
            }
        }, 1_000);
    }

    async function sendCode() {
        await postJson('/api/studio/auth/request', { email: loginEmail });
        setAuthState('code');
        authStatus.textContent = 'If this email is approved, the code should arrive shortly.';
        startResendCountdown();
    }

    function createCell(className) {
        const cell = document.createElement('td');
        if (className) cell.className = className;
        return cell;
    }

    function orderRow(order) {
        const row = document.createElement('tr');
        row.className = 'studio-order-row';
        row.tabIndex = 0;
        row.dataset.orderId = order.id;
        row.setAttribute('aria-label', `Open order for ${order.customerName}`);

        const customer = createCell();
        const customerName = document.createElement('strong');
        customerName.textContent = order.customerName;
        const customerEmail = document.createElement('span');
        customerEmail.textContent = order.customerEmail;
        customer.append(customerName, customerEmail);

        const session = createCell('studio-order-session');
        const workshop = document.createElement('strong');
        workshop.textContent = order.workshop;
        const sessionValue = document.createElement('span');
        sessionValue.textContent = formatSession(order.sessionDate, order.sessionPeriod);
        session.append(workshop, sessionValue);

        const amount = createCell('studio-order-amount');
        amount.textContent = formatAmount(order.amount, order.currency);

        const state = createCell('studio-order-state');
        const badge = document.createElement('span');
        badge.className = 'studio-status';
        badge.dataset.state = order.state;
        badge.textContent = titleCase(order.state);
        const mode = document.createElement('span');
        mode.className = 'studio-order-mode';
        mode.textContent = order.environment;
        state.append(badge, mode);

        const ordered = createCell('studio-order-date');
        const time = document.createElement('time');
        time.dateTime = order.createdAt || '';
        time.textContent = formatDate(order.createdAt);
        const reference = document.createElement('span');
        reference.textContent = order.reference;
        ordered.append(time, reference);

        const arrow = createCell('studio-row-arrow');
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '→';
        row.append(customer, session, amount, state, ordered, arrow);
        return row;
    }

    function renderOrders() {
        ordersBody.replaceChildren(...orders.map(orderRow));
        const label = total === 1 ? '1 order' : `${total.toLocaleString('en-NG')} orders`;
        orderCount.textContent = label;
        listFrame.setAttribute('aria-busy', String(loadingOrders));

        if (listError) {
            listState.hidden = false;
            listState.textContent = listError;
        } else if (loadingOrders && orders.length === 0) {
            listState.hidden = false;
            listState.textContent = 'Loading orders…';
        } else if (orders.length === 0) {
            listState.hidden = false;
            listState.textContent = 'No orders match this view.';
        } else {
            listState.hidden = true;
        }

        loadMore.hidden = orders.length >= total || orders.length === 0;
        loadMore.disabled = loadingOrders;
        loadMore.textContent = loadingOrders ? 'Loading…' : 'Load more orders';
    }

    async function loadOrders({ reset = false } = {}) {
        if (reset && listRequest) listRequest.abort();
        if (loadingOrders && !reset) return;
        loadingOrders = true;
        if (reset) {
            orders = [];
            total = 0;
        }
        listError = '';
        renderOrders();

        const controller = new AbortController();
        listRequest = controller;
        const params = new URLSearchParams({
            q: searchInput.value.trim(),
            status: statusFilter.value,
            environment: environmentFilter.value,
            limit: String(PAGE_SIZE),
            offset: String(orders.length),
        });

        try {
            const result = await request(`/api/studio/orders?${params}`, { signal: controller.signal });
            orders = reset ? result.orders : [...orders, ...result.orders];
            total = result.total;
            listError = '';
        } catch (error) {
            if (error.name === 'AbortError') return;
            if (error.status === 401) return showLogin();
            listError = error.message;
        } finally {
            if (listRequest === controller) {
                loadingOrders = false;
                listRequest = null;
                renderOrders();
            }
        }
    }

    function detail(name, value) {
        const element = panelContent.querySelector(`[data-detail="${name}"]`);
        if (element) element.textContent = value || '—';
    }

    function fillOrderPanel(order) {
        activeOrder = order;
        panelTitle.textContent = order.customerName;
        detail('amount', formatAmount(order.amount, order.currency));
        const state = panelContent.querySelector('[data-detail="state"]');
        state.textContent = titleCase(order.state);
        state.dataset.state = order.state;
        detail('customerName', order.customerName);
        detail('customerEmail', order.customerEmail);
        detail('workshop', order.workshop);
        detail('session', formatSession(order.sessionDate, order.sessionPeriod));
        detail('quantity', String(order.quantity));
        detail('bookingStatus', titleCase(order.bookingStatus));
        detail('id', order.id);
        detail('createdAt', formatDate(order.createdAt));
        detail('expiresAt', formatDate(order.expiresAt));
        detail('paymentStatus', titleCase(order.paymentStatus));
        detail('providerStatus', titleCase(order.providerStatus));
        detail('environment', titleCase(order.environment));
        detail('reference', order.reference);
        detail('providerTransactionId', order.providerTransactionId);
        detail('paidAt', formatDate(order.paidAt));
        detail('verifiedAt', formatDate(order.verifiedAt));

        try {
            const url = new URL(order.paystackDashboardUrl);
            paystackLink.href = url.origin === 'https://dashboard.paystack.com'
                ? url.href
                : 'https://dashboard.paystack.com/#/transactions';
        } catch {
            paystackLink.href = 'https://dashboard.paystack.com/#/transactions';
        }

        copyReference.hidden = !order.reference;
        copyReference.textContent = 'Copy payment reference';
        panelStatus.textContent = '';
        panelContent.hidden = false;
    }

    async function openOrder(orderId, { updateUrl = true } = {}) {
        if (!orderId) return;
        lastFocused = document.activeElement;
        panelLayer.hidden = false;
        document.body.classList.add('studio-panel-open');
        panelContent.hidden = true;
        panelStatus.textContent = 'Loading order…';
        panelTitle.textContent = 'Loading…';
        panel.focus();

        if (updateUrl) {
            const url = new URL(window.location.href);
            url.searchParams.set('order', orderId);
            window.history.pushState({ studioOrder: true, orderId }, '', url);
        }

        try {
            fillOrderPanel(await request(`/api/studio/orders/${encodeURIComponent(orderId)}`));
        } catch (error) {
            if (error.status === 401) return showLogin();
            activeOrder = null;
            panelTitle.textContent = 'Order unavailable';
            panelStatus.textContent = error.message;
        }
    }

    function closeOrder({ updateUrl = true, restoreFocus = true } = {}) {
        if (panelLayer.hidden) return;
        panelLayer.hidden = true;
        document.body.classList.remove('studio-panel-open');
        activeOrder = null;
        if (updateUrl) {
            if (window.history.state?.studioOrder) {
                window.history.back();
            } else {
                const url = new URL(window.location.href);
                url.searchParams.delete('order');
                window.history.replaceState({}, '', url);
            }
        }
        if (restoreFocus && lastFocused instanceof HTMLElement) lastFocused.focus();
    }

    emailForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        loginEmail = emailInput.value.trim().toLowerCase();
        const button = emailForm.querySelector('button[type="submit"]');
        authStatus.textContent = '';
        setButtonBusy(button, true, 'Sending…');
        try {
            await sendCode();
        } catch (error) {
            authStatus.textContent = error.message;
        } finally {
            setButtonBusy(button, false);
        }
    });

    codeForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = codeForm.querySelector('button[type="submit"]');
        authStatus.textContent = '';
        setButtonBusy(button, true, 'Verifying…');
        try {
            const session = await postJson('/api/studio/auth/verify', {
                email: loginEmail,
                token: codeInput.value.trim(),
            });
            window.clearInterval(resendTimer);
            await showDashboard(session.email);
        } catch (error) {
            authStatus.textContent = error.message;
            codeInput.select();
        } finally {
            setButtonBusy(button, false);
        }
    });

    document.getElementById('studio-change-email').addEventListener('click', () => {
        window.clearInterval(resendTimer);
        setAuthState('email');
    });

    resendButton.addEventListener('click', async () => {
        if (resendSeconds > 0) return;
        authStatus.textContent = '';
        resendButton.disabled = true;
        resendButton.textContent = 'Sending…';
        try {
            await sendCode();
        } catch (error) {
            authStatus.textContent = error.message;
            resendButton.disabled = false;
            resendButton.textContent = 'Resend code';
        }
    });

    logoutButton.addEventListener('click', async () => {
        logoutButton.disabled = true;
        try {
            await postJson('/api/studio/auth/logout');
        } finally {
            logoutButton.disabled = false;
            showLogin();
        }
    });

    searchInput.addEventListener('input', () => {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => loadOrders({ reset: true }), 300);
    });

    statusFilter.addEventListener('change', () => loadOrders({ reset: true }));
    environmentFilter.addEventListener('change', () => loadOrders({ reset: true }));
    loadMore.addEventListener('click', () => loadOrders());

    ordersBody.addEventListener('click', (event) => {
        const row = event.target.closest('[data-order-id]');
        if (row) openOrder(row.dataset.orderId);
    });

    ordersBody.addEventListener('keydown', (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        const row = event.target.closest('[data-order-id]');
        if (!row) return;
        event.preventDefault();
        openOrder(row.dataset.orderId);
    });

    document.querySelectorAll('[data-close-order]').forEach((button) => {
        button.addEventListener('click', () => closeOrder());
    });

    copyReference.addEventListener('click', async () => {
        if (!activeOrder?.reference) return;
        try {
            await navigator.clipboard.writeText(activeOrder.reference);
            copyReference.textContent = 'Reference copied';
        } catch {
            copyReference.textContent = activeOrder.reference;
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !panelLayer.hidden) closeOrder();
        if (event.key !== 'Tab' || panelLayer.hidden) return;
        const focusable = [...panel.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
            .filter((element) => !element.hidden);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });

    window.addEventListener('popstate', () => {
        const orderId = new URL(window.location.href).searchParams.get('order');
        if (orderId) openOrder(orderId, { updateUrl: false });
        else closeOrder({ updateUrl: false });
    });

    async function initialise() {
        authStatus.textContent = 'Checking your session…';
        try {
            const session = await request('/api/studio/session');
            if (session.authenticated) return showDashboard(session.email);
        } catch {
            // Login remains available if session checking is temporarily unavailable.
        }
        showLogin();
    }

    initialise();
})();
