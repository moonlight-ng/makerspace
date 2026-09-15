export const WORKSHOP = Object.freeze({
    slug: 'introduction-to-3d-printing',
    name: 'Intro to 3D Printing',
    description: 'A practical introduction to digital fabrication, from preparing a model to printing a finished object.',
});

export const CLAY_WORKSHOP = Object.freeze({
    slug: 'introduction-to-clay',
    name: 'Intro to Clay',
    description: 'A guided introduction to the pottery wheel with Kabir, from centring clay to shaping your first form.',
});

export const WORKSHOPS = Object.freeze([WORKSHOP, CLAY_WORKSHOP]);

const EVENT_AMOUNT = 3_000_000;

const PRINTING_EVENTS = [
    Object.freeze({ slug: 'intro-to-3d-printing-2026-09-03', date: '2026-09-03', period: 'evening', capacity: 1, amount: EVENT_AMOUNT }),
    Object.freeze({ slug: 'intro-to-3d-printing-2026-09-05', date: '2026-09-05', period: 'morning', capacity: 1, amount: EVENT_AMOUNT }),
    Object.freeze({ slug: 'intro-to-3d-printing-2026-09-10', date: '2026-09-10', period: 'evening', capacity: 1, amount: EVENT_AMOUNT }),
    Object.freeze({ slug: 'intro-to-3d-printing-2026-09-12', date: '2026-09-12', period: 'morning', capacity: 1, amount: EVENT_AMOUNT }),
    Object.freeze({ slug: 'intro-to-3d-printing-2026-09-17', date: '2026-09-17', period: 'evening', capacity: 1, amount: EVENT_AMOUNT }),
    Object.freeze({ slug: 'intro-to-3d-printing-2026-09-19', date: '2026-09-19', period: 'morning', capacity: 1, amount: EVENT_AMOUNT }),
    Object.freeze({ slug: 'intro-to-3d-printing-2026-09-24', date: '2026-09-24', period: 'evening', capacity: 1, amount: EVENT_AMOUNT }),
    Object.freeze({ slug: 'intro-to-3d-printing-2026-09-26', date: '2026-09-26', period: 'morning', capacity: 1, amount: EVENT_AMOUNT }),
];

export const EVENTS = Object.freeze([
    ...PRINTING_EVENTS.map((event) => Object.freeze({ ...event, classSlug: WORKSHOP.slug })),
    ...PRINTING_EVENTS.map((event) => Object.freeze({
        ...event,
        slug: event.slug.replace('intro-to-3d-printing', 'intro-to-clay'),
        classSlug: CLAY_WORKSHOP.slug,
    })),
]);

export const SESSION_CAPACITY = 1;
export const PAYMENT_CURRENCY = 'NGN';
export const MAKERSPACE_SUBACCOUNT_CODE = 'ACCT_x95j3w6lcfe44s4';
export const PAYMENT_CALLBACK_URL = 'https://makerspace.16by16.co/payment-complete/';

export function getEvent(eventSlug) {
    return EVENTS.find((event) => event.slug === eventSlug) || null;
}

export function isEventUpcoming(event, now = Date.now()) {
    // Lagos is UTC+1: morning sessions start at 11am, evening sessions at 4pm.
    const startHourUtc = event.period === 'morning' ? '10' : '15';
    return Date.parse(`${event.date}T${startHourUtc}:00:00Z`) > now;
}

export function getWorkshop(classSlug) {
    return WORKSHOPS.find((workshop) => workshop.slug === classSlug) || null;
}
