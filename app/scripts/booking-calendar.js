(() => {
    const form = document.getElementById('booking-form');
    if (!form) return;

    const status = document.getElementById('booking-status');
    const submitButton = form.querySelector('button[type="submit"]');
    let eventInputs = [];
    const steps = Array.from(form.querySelectorAll('fieldset'));
    const submitRow = form.querySelector('.booking-submit-row');
    const quantityOutput = document.getElementById('booking-quantity');
    const totalOutput = document.getElementById('booking-total');
    const stepButtons = Array.from(form.querySelectorAll('[data-quantity-step]'));
    const eventCatalog = new Map();
    const bookingToggles = Array.from(document.querySelectorAll('[data-workshop][aria-controls="booking-panel"]'));
    const workshopCatalog = new Map();
    const bookingPanel = document.getElementById('booking-panel');
    const bookingTitle = document.getElementById('booking-workshop-title');
    const dateGrid = form.querySelector('.booking-choice-grid--dates');

    const review = document.getElementById('booking-review');
    const reviewKicker = document.getElementById('booking-review-kicker');
    const reviewTitle = document.getElementById('booking-review-title');
    const reviewIntro = document.getElementById('booking-review-intro');
    const reviewCountdown = document.getElementById('booking-review-countdown');
    const reviewNotice = document.getElementById('booking-review-notice');
    const reviewCancelButton = document.getElementById('booking-review-cancel');
    const reviewPayButton = document.getElementById('booking-review-pay');
    const searchParams = new URLSearchParams(window.location.search);
    const previewFlowEnabled = searchParams.get('booking-flow') === 'preview';
    const requestedPreviewHoldSeconds = Number(searchParams.get('hold-seconds'));

    const DEFAULT_CAPACITY = 1;
    const DEFAULT_PRICE = 30000;
    const HOLD_DURATION_MS = 10 * 60 * 1000;
    const previewHoldDurationMs = (
        previewFlowEnabled
        && Number.isInteger(requestedPreviewHoldSeconds)
        && requestedPreviewHoldSeconds >= 1
        && requestedPreviewHoldSeconds <= 600
    ) ? requestedPreviewHoldSeconds * 1000 : HOLD_DURATION_MS;
    const SURFACE_TRANSITION_MS = 210;
    const SESSION_TIMES = Object.freeze({
        morning: '11am - 2pm',
        evening: '4 - 7pm',
    });

    let quantity = 1;
    let activeReservation = null;
    let countdownInterval = null;
    let holdEndsAt = 0;
    let reviewState = 'idle';
    let paymentPreview = null;
    let availabilityLoaded = false;
    let activeWorkshopSlug = bookingToggles[0]?.dataset.workshop || 'introduction-to-3d-printing';

    const formatNaira = (amount) => `₦${amount.toLocaleString('en-NG')}`;

    function setBookingOpen(open, toggle = bookingToggles.find((button) => button.dataset.workshop === activeWorkshopSlug)) {
        if (!toggle || !bookingPanel) return;
        if (toggle.dataset.workshop !== activeWorkshopSlug) {
            activeWorkshopSlug = toggle.dataset.workshop;
            quantity = 1;
            window.clearInterval(countdownInterval);
            reviewState = 'idle';
            activeReservation = null;
            closePaymentPreview(false);
            if (review) review.hidden = true;
            form.hidden = false;
            renderEventCalendar();
        }
        bookingPanel.hidden = !open;
        bookingToggles.forEach((button) => {
            const expanded = open && button === toggle;
            button.setAttribute('aria-expanded', String(expanded));
            button.querySelector('span').textContent = expanded
                ? `Close ${button.dataset.workshopName} booking`
                : `Book ${button.dataset.workshopName}`;
        });
        if (bookingTitle) bookingTitle.textContent = `Book your ${toggle.dataset.workshopName} session`;
        updateAvailabilityStatus();

        if (open) {
            bookingPanel.classList.remove('is-revealed');
            void bookingPanel.offsetWidth;
            bookingPanel.classList.add('is-revealed');
            bookingPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function selectedEvent() {
        const input = form.querySelector('input[name="event"]:checked');
        return input ? eventCatalog.get(input.value) : null;
    }

    function selectedPrice() {
        const event = selectedEvent();
        return event ? event.amount / 100 : DEFAULT_PRICE;
    }

    function bookingsAvailable() {
        const event = selectedEvent();
        return event ? Math.max(1, event.remaining) : DEFAULT_CAPACITY;
    }

    function updateOrder() {
        const maximum = bookingsAvailable();
        quantity = Math.min(Math.max(1, quantity), maximum);
        if (quantityOutput) quantityOutput.textContent = String(quantity);
        if (totalOutput) totalOutput.textContent = formatNaira(selectedPrice() * quantity);

        stepButtons.forEach((button) => {
            const step = Number(button.dataset.quantityStep);
            button.disabled = step < 0 ? quantity <= 1 : quantity >= maximum;
        });
    }

    function setStatus(message) {
        if (status) status.textContent = message;
    }

    function formatSessionDate(value) {
        return new Intl.DateTimeFormat('en-NG', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(new Date(`${value}T12:00:00Z`));
    }

    function formatCountdown(milliseconds) {
        const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function setReviewValue(name, value, detail = '') {
        const output = review?.querySelector(`[data-review-value="${name}"]`);
        if (!output) return;
        output.textContent = value;
        if (detail) {
            const small = document.createElement('small');
            small.textContent = detail;
            output.append(small);
        }
    }

    function createPaymentPreview() {
        const element = document.createElement('div');
        element.className = 'booking-payment-preview';
        element.hidden = true;
        element.innerHTML = `
            <section class="booking-payment-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="booking-payment-preview-title">
                <header class="booking-payment-preview-header">
                    <strong>Makerspace × Paystack</strong>
                    <button type="button" class="booking-payment-preview-close">Close</button>
                </header>
                <div class="booking-payment-preview-copy">
                    <p class="making-label">Payment handoff</p>
                    <h2 id="booking-payment-preview-title" tabindex="-1">Pay securely.</h2>
                    <p>This is where Paystack checkout opens. The transaction is created for this event and assigned to the Makerspace subaccount.</p>
                </div>
                <dl class="booking-payment-preview-meta">
                    <div><dt>Total</dt><dd data-payment-preview-value="total"></dd></div>
                    <div><dt>Email</dt><dd data-payment-preview-value="email"></dd></div>
                    <div><dt>Hold</dt><dd data-payment-preview-value="remaining"></dd></div>
                </dl>
                <button type="button" class="booking-payment-preview-return">Cancel payment</button>
            </section>
        `;

        element.querySelectorAll('.booking-payment-preview-close, .booking-payment-preview-return')
            .forEach((button) => button.addEventListener('click', cancelPaymentPreview));
        element.addEventListener('click', (event) => {
            if (event.target === element) cancelPaymentPreview();
        });
        document.body.append(element);
        return element;
    }

    function paymentPreviewValue(name) {
        return paymentPreview?.querySelector(`[data-payment-preview-value="${name}"]`);
    }

    function closePaymentPreview(restoreFocus = true) {
        if (!paymentPreview || paymentPreview.hidden) return;
        paymentPreview.hidden = true;
        document.body.classList.remove('booking-payment-preview-open');
        if (restoreFocus && reviewState === 'held') reviewPayButton?.focus();
    }

    function cancelPaymentPreview() {
        if (!paymentPreview || paymentPreview.hidden || reviewState !== 'held') return;
        closePaymentPreview(false);
        cancelPreviewReservation();
    }

    function openPaymentPreview() {
        if (!paymentPreview || !activeReservation || reviewState !== 'held') return;
        const total = paymentPreviewValue('total');
        const email = paymentPreviewValue('email');
        if (total) total.textContent = formatNaira(activeReservation.total);
        if (email) email.textContent = activeReservation.payload.email;
        paymentPreview.hidden = false;
        document.body.classList.add('booking-payment-preview-open');
        paymentPreview.querySelector('#booking-payment-preview-title')?.focus();
        updateCountdown();
    }

    function transitionSurface(from, to, focusTarget) {
        if (!from || !to) return Promise.resolve();
        from.classList.add('is-surface-leaving');

        return new Promise((resolve) => {
            window.setTimeout(() => {
                from.hidden = true;
                from.classList.remove('is-surface-leaving');
                to.hidden = false;
                void to.offsetWidth;
                to.classList.add('is-surface-entering');
                to.scrollIntoView({ behavior: 'smooth', block: 'start' });
                window.setTimeout(() => {
                    to.classList.remove('is-surface-entering');
                    focusTarget?.focus({ preventScroll: true });
                    resolve();
                }, 430);
            }, SURFACE_TRANSITION_MS);
        });
    }

    function updateCountdown() {
        if (reviewState !== 'held') return;
        const remaining = holdEndsAt - Date.now();
        const display = formatCountdown(remaining);
        if (reviewCountdown) reviewCountdown.textContent = display;
        const paymentRemaining = paymentPreviewValue('remaining');
        if (paymentRemaining) paymentRemaining.textContent = `${display} remaining`;
        review?.classList.toggle('is-urgent', remaining <= 60 * 1000);
        if (remaining <= 0) expirePreviewReservation();
    }

    function startCountdown() {
        window.clearInterval(countdownInterval);
        holdEndsAt = Date.now() + previewHoldDurationMs;
        updateCountdown();
        countdownInterval = window.setInterval(updateCountdown, 1000);
    }

    function renderReview(payload) {
        const event = eventCatalog.get(payload.eventSlug);
        const total = (event.amount / 100) * quantity;
        activeReservation = { payload, total };
        setReviewValue('workshop', workshopCatalog.get(event.classSlug)?.name || event.title);
        setReviewValue('date', formatSessionDate(event.date));
        setReviewValue('time', SESSION_TIMES[event.period]);
        setReviewValue('customer', payload.name, payload.email);
        setReviewValue('total', formatNaira(total));

        reviewKicker.textContent = 'Reservation held';
        reviewTitle.textContent = 'Review booking';
        reviewIntro.textContent = 'Your session is set aside. Complete payment before the timer reaches zero.';
        reviewNotice.textContent = 'Cancelling releases the session immediately. Payment is handled securely by Paystack.';
        reviewCancelButton.hidden = false;
        reviewCancelButton.disabled = false;
        reviewCancelButton.textContent = 'Cancel reservation';
        reviewPayButton.disabled = false;
        reviewPayButton.textContent = `Pay ${formatNaira(total)}`;
        review.classList.remove('is-expired', 'is-urgent');
    }

    function showPreviewReservation(payload) {
        renderReview(payload);
        reviewState = 'held';
        startCountdown();
        submitButton.disabled = false;
        transitionSurface(form, review, reviewTitle);
    }

    function returnToBookingForm(message) {
        window.clearInterval(countdownInterval);
        countdownInterval = null;
        closePaymentPreview(false);
        reviewState = 'idle';
        activeReservation = null;
        transitionSurface(review, form, form.querySelector('input[name="event"]:checked'))
            .then(() => setStatus(message));
    }

    function cancelPreviewReservation() {
        if (reviewState !== 'held') return;
        reviewCancelButton.disabled = true;
        reviewPayButton.disabled = true;
        window.setTimeout(() => {
            returnToBookingForm('Reservation cancelled. This session is available again.');
        }, 320);
    }

    function expirePreviewReservation() {
        if (reviewState !== 'held') return;
        reviewState = 'expired';
        window.clearInterval(countdownInterval);
        countdownInterval = null;
        closePaymentPreview(false);
        review?.classList.remove('is-urgent');
        review?.classList.add('is-expired');
        if (reviewCountdown) reviewCountdown.textContent = '00:00';
        reviewKicker.textContent = 'Hold ended';
        reviewTitle.textContent = 'Reservation expired';
        reviewIntro.textContent = 'The payment window is over, so this session is available to book again.';
        reviewNotice.textContent = 'Nothing was charged. Choose an event again to start a new reservation.';
        reviewCancelButton.hidden = true;
        reviewPayButton.disabled = false;
        reviewPayButton.textContent = 'Choose another event';
        reviewTitle.focus({ preventScroll: true });
    }

    async function cancelReservedBooking(booking) {
        const response = await fetch('/api/bookings/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ bookingId: booking.bookingId, reference: booking.reference }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'The reservation could not be released.');
        return result;
    }

    async function releaseReservedBooking(booking, reason) {
        setStatus(`${reason} Releasing your reservation…`);
        try {
            await cancelReservedBooking(booking);
            await loadAvailability();
            setStatus(`${reason} Your reservation has been released.`);
        } catch {
            setStatus(`${reason} The reservation will be released when the hold expires.`);
        } finally {
            submitButton.disabled = false;
        }
    }

    function openPaystackCheckout(booking) {
        const checkoutUrl = booking.checkout?.authorizationUrl;
        if (!checkoutUrl) throw new Error('The Paystack checkout link is missing. Please try again.');
        const url = new URL(checkoutUrl, window.location.origin);
        if (url.origin !== 'https://checkout.paystack.com' && url.origin !== window.location.origin) {
            throw new Error('The payment destination could not be verified.');
        }
        window.location.assign(url.href);
    }

    function isStepAnswered(step) {
        if (step.contains(dateGrid)) return Boolean(selectedEvent());
        const groups = new Set(
            Array.from(step.querySelectorAll('input[type="radio"]')).map((input) => input.name),
        );
        return Array.from(groups).every((name) => form.querySelector(`input[name="${name}"]:checked`));
    }

    function setStepHidden(step, hidden) {
        if (step.hidden === hidden) return;
        step.hidden = hidden;
        if (!hidden) {
            step.classList.remove('is-revealed');
            void step.offsetWidth;
            step.classList.add('is-revealed');
        }
    }

    function updateSteps() {
        let reveal = true;
        steps.forEach((step) => {
            setStepHidden(step, !reveal);
            if (reveal) reveal = isStepAnswered(step);
        });
        if (submitRow) setStepHidden(submitRow, !reveal);
        updateOrder();
    }

    function updateDateSelectionState() {
        const selectedInput = eventInputs.find((input) => input.checked && !input.disabled);
        dateGrid?.classList.toggle('has-selection', Boolean(selectedInput));
        eventInputs.forEach((input) => {
            const label = input.closest('label');
            if (label) label.hidden = input.disabled || Boolean(selectedInput && input !== selectedInput);
        });
    }

    function updateEventChoices() {
        eventInputs.forEach((input) => {
            const event = eventCatalog.get(input.value);
            const remaining = event?.remaining ?? DEFAULT_CAPACITY;
            const available = availabilityLoaded && Boolean(event) && remaining > 0;
            input.disabled = !available;
            if (input.disabled && input.checked) input.checked = false;
        });
        updateDateSelectionState();
        updateSteps();
    }

    function applyEventCalendar(events = []) {
        eventCatalog.clear();
        events.forEach((event) => {
            eventCatalog.set(event.slug, event);
        });
        renderEventCalendar();
    }

    function renderEventCalendar() {
        if (!dateGrid) return;
        const selectedSlug = selectedEvent()?.slug;
        dateGrid.replaceChildren();
        for (const event of eventCatalog.values()) {
            if (event.classSlug !== activeWorkshopSlug) continue;
            const label = document.createElement('label');
            label.innerHTML = '<input type="radio" name="event" required disabled><span><span class="booking-date-head"><span><small></small><span class="booking-date-label"></span></span><small class="booking-date-time"></small></span></span>';
            const input = label.querySelector('input');
            input.value = event.slug;
            input.checked = event.slug === selectedSlug;
            const date = new Date(`${event.date}T12:00:00Z`);
            label.querySelector('small').textContent = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(date);
            label.querySelector('.booking-date-label').textContent = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(date);
            label.querySelector('.booking-date-time').textContent = SESSION_TIMES[event.period];
            label.addEventListener('click', (click) => {
                if (click.target === input || !input.checked || input.disabled) return;
                click.preventDefault();
                input.checked = false;
                updateDateSelectionState();
                updateSteps();
            });
            input.addEventListener('keydown', (key) => {
                if ((key.key !== ' ' && key.key !== 'Enter') || !input.checked) return;
                key.preventDefault();
                input.checked = false;
                updateDateSelectionState();
                updateSteps();
            });
            dateGrid.append(label);
        }
        eventInputs = Array.from(dateGrid.querySelectorAll('input'));
        updateEventChoices();
    }

    function updateAvailabilityStatus() {
        if (!availabilityLoaded) return;
        setStatus(eventInputs.some((input) => !input.disabled)
            ? ''
            : 'All sessions are currently booked. Please check back for new dates.');
    }

    async function loadAvailability() {
        try {
            const response = await fetch('/api/availability', { headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error('Availability could not be loaded');
            const data = await response.json();
            (data.workshops || []).forEach((workshop) => workshopCatalog.set(workshop.slug, workshop));
            availabilityLoaded = true;
            applyEventCalendar(data.events || []);
            updateAvailabilityStatus();
        } catch {
            availabilityLoaded = false;
            setStatus(previewFlowEnabled ? '' : 'Available sessions could not be loaded. Please try again.');
            updateEventChoices();
        }
    }

    stepButtons.forEach((button) => {
        button.addEventListener('click', () => {
            quantity += Number(button.dataset.quantityStep);
            updateOrder();
        });
    });

    bookingToggles.forEach((button) => {
        button.addEventListener('click', () => {
            setBookingOpen(button.getAttribute('aria-expanded') !== 'true', button);
        });
    });

    form.addEventListener('change', (event) => {
        if (event.target.matches('input[name="event"]')) updateDateSelectionState();
        updateSteps();
    });
    reviewCancelButton?.addEventListener('click', cancelPreviewReservation);
    reviewPayButton?.addEventListener('click', () => {
        if (reviewState === 'expired') {
            returnToBookingForm('That hold expired. Choose an event to reserve again.');
            loadAvailability();
            return;
        }
        openPaymentPreview();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && paymentPreview && !paymentPreview.hidden) cancelPaymentPreview();
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) updateCountdown();
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!selectedEvent()) {
            setStatus('Choose an available session.');
            return;
        }
        if (!form.reportValidity()) return;

        const payload = {
            eventSlug: form.elements.event.value,
            quantity,
            name: form.elements.name.value.trim(),
            email: form.elements.email.value.trim(),
        };

        submitButton.disabled = true;
        setStatus('Reserving your place…');

        if (previewFlowEnabled && review) {
            window.setTimeout(() => showPreviewReservation(payload), 520);
            return;
        }

        let createdBooking = null;
        try {
            const response = await fetch('/api/bookings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await response.json();
            if (!response.ok) {
                if (response.status === 409) await loadAvailability();
                throw new Error(data.error || 'We could not reserve that place.');
            }

            createdBooking = data;
            setStatus('Your place is reserved. Opening secure checkout…');
            openPaystackCheckout(data);
        } catch (error) {
            if (createdBooking) {
                await releaseReservedBooking(createdBooking, error.message || 'Payment could not start.');
            } else {
                setStatus(error.message || 'We could not reserve that place. Please try again.');
                submitButton.disabled = false;
            }
        }
    });

    if (previewFlowEnabled && review) {
        setStatus('');
        paymentPreview = createPaymentPreview();
        window.bookingFlowPreview = Object.freeze({
            expire: expirePreviewReservation,
            cancel: cancelPreviewReservation,
            closePayment: cancelPaymentPreview,
            getRemaining: () => Math.max(0, holdEndsAt - Date.now()),
        });
    }

    updateSteps();
    if (window.location.hash === '#events') {
        window.history.replaceState(null, '', '#workshop');
    }
    setBookingOpen(false);
    loadAvailability();
})();
