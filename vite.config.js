import { resolve } from 'path'
import { randomUUID } from 'node:crypto'
import { defineConfig, loadEnv } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import studioLogoutHandler from './api/studio/auth/logout.js'
import studioRequestHandler from './api/studio/auth/request.js'
import studioVerifyHandler from './api/studio/auth/verify.js'
import studioOrdersHandler from './api/studio/orders.js'
import studioOrderHandler from './api/studio/orders/[bookingId].js'
import studioSessionHandler from './api/studio/session.js'
import {
    EVENTS,
    getEvent,
    MAKERSPACE_SUBACCOUNT_CODE,
    WORKSHOP,
} from './server/config.js'

const bookingApiPlugin = () => {
    const bookings = []
    const payments = []

    const sendJson = (res, status, body) => {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(body))
    }

    const readBody = (req) => new Promise((resolve, reject) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'))
            } catch (error) {
                reject(error)
            }
        })
        req.on('error', reject)
    })

    return {
        name: 'booking-api',
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                const url = new URL(req.url, 'http://localhost')

                if (url.pathname === '/api/availability' && req.method === 'GET') {
                    const events = EVENTS.map((event) => {
                        const reserved = bookings
                            .filter((booking) => (
                                booking.eventSlug === event.slug
                                && ['reserved', 'paid'].includes(booking.status)
                            ))
                            .reduce((total, booking) => total + booking.quantity, 0)
                        return {
                            ...event,
                            title: WORKSHOP.name,
                            currency: 'NGN',
                            reserved,
                            remaining: Math.max(0, event.capacity - reserved),
                        }
                    })

                    return sendJson(res, 200, { workshop: WORKSHOP, events })
                }

                if (url.pathname === '/api/bookings' && req.method === 'POST') {
                    try {
                        const input = await readBody(req)
                        const event = getEvent(input.eventSlug)
                        if (!event) return sendJson(res, 400, { error: 'Choose a valid event.' })

                        const quantity = Number(input.quantity || 1)
                        if (!Number.isInteger(quantity) || quantity < 1 || quantity > event.capacity) {
                            return sendJson(res, 400, { error: `Choose between 1 and ${event.capacity} places.` })
                        }

                        const reserved = bookings
                            .filter((booking) => (
                                booking.eventSlug === event.slug
                                && ['reserved', 'paid'].includes(booking.status)
                            ))
                            .reduce((total, booking) => total + booking.quantity, 0)

                        if (reserved + quantity > event.capacity) {
                            return sendJson(res, 409, { error: 'That session has just filled up. Please choose another.' })
                        }

                        const bookingId = randomUUID()
                        const reference = `local-${Date.now().toString(36)}-${bookingId.replaceAll('-', '').slice(0, 8)}`
                        bookings.push({
                            ...input,
                            date: event.date,
                            period: event.period,
                            quantity,
                            id: bookingId,
                            status: 'reserved',
                        })
                        payments.push({
                            reference,
                            bookingId,
                            eventSlug: event.slug,
                            subaccountCode: MAKERSPACE_SUBACCOUNT_CODE,
                            amount: event.amount * quantity,
                            currency: 'NGN',
                            environment: 'test',
                            status: 'pending',
                            createdAt: new Date().toISOString(),
                        })
                        return sendJson(res, 201, {
                            bookingId,
                            reference,
                            checkout: {
                                accessCode: `local-${reference}`,
                                authorizationUrl: `/payment-complete/?reference=${encodeURIComponent(reference)}`,
                                amount: event.amount * quantity,
                                currency: 'NGN',
                                reference,
                                environment: 'test',
                            },
                        })
                    } catch (error) {
                        return sendJson(res, 400, { error: 'The booking details could not be read.' })
                    }
                }

                if (url.pathname === '/api/bookings/cancel' && req.method === 'POST') {
                    try {
                        const input = await readBody(req)
                        const booking = bookings.find((candidate) => candidate.id === input.bookingId)
                        const payment = payments.find((candidate) => (
                            candidate.bookingId === input.bookingId
                            && candidate.reference === input.reference
                        ))

                        if (!booking || !payment) {
                            return sendJson(res, 404, { error: 'We could not find that reservation.' })
                        }
                        if (booking.status === 'cancelled') {
                            return sendJson(res, 200, { cancelled: true, alreadyCancelled: true })
                        }
                        if (booking.status === 'paid' || payment.status === 'success') {
                            return sendJson(res, 409, { error: 'That booking has already been paid.' })
                        }
                        if (booking.status !== 'reserved' || payment.status !== 'pending') {
                            return sendJson(res, 409, { error: 'That reservation can no longer be cancelled.' })
                        }

                        booking.status = 'cancelled'
                        payment.status = 'failed'
                        payment.providerStatus = 'customer_cancelled_popup'
                        return sendJson(res, 200, { cancelled: true, alreadyCancelled: false })
                    } catch (error) {
                        return sendJson(res, 400, { error: 'The cancellation details could not be read.' })
                    }
                }

                if (url.pathname === '/api/payments/status' && req.method === 'GET') {
                    const reference = url.searchParams.get('reference')
                    const payment = payments.find((candidate) => candidate.reference === reference)
                    const booking = bookings.find((candidate) => candidate.id === payment?.bookingId)
                    if (!payment || !booking) {
                        return sendJson(res, 404, { error: 'We could not find that payment.' })
                    }

                    return sendJson(res, 200, {
                        ...payment,
                        email: booking.email.toLowerCase(),
                        customerName: booking.name,
                        workshop: WORKSHOP.name,
                        classSlug: WORKSHOP.slug,
                        eventSlug: booking.eventSlug,
                        sessionDate: booking.date,
                        sessionPeriod: booking.period,
                        quantity: booking.quantity,
                    })
                }

                next()
            })
        },
    }
}

const studioApiPlugin = () => {
    const handlers = new Map([
        ['/api/studio/auth/request', studioRequestHandler],
        ['/api/studio/auth/verify', studioVerifyHandler],
        ['/api/studio/auth/logout', studioLogoutHandler],
        ['/api/studio/session', studioSessionHandler],
        ['/api/studio/orders', studioOrdersHandler],
    ])

    return {
        name: 'studio-api',
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '')
                const handler = handlers.get(pathname)
                    || (/^\/api\/studio\/orders\/[^/]+$/.test(pathname) ? studioOrderHandler : null)
                if (!handler) return next()
                await handler(req, res)
            })
        },
    }
}

const rewritePlugin = () => {
    return {
        name: 'rewrite-middleware',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url.startsWith('/makerspace')) {
                    req.url = req.url.replace('/makerspace', '/pages/makerspace')
                } else if (req.url.startsWith('/building')) {
                    req.url = req.url.replace('/building', '/pages/building')
                } else if (req.url.startsWith('/contact')) {
                    req.url = req.url.replace('/contact', '/pages/contact')
                } else if (req.url.startsWith('/film-club')) {
                    req.url = req.url.replace('/film-club', '/pages/film-club')
                } else if (req.url.startsWith('/payment-complete')) {
                    req.url = req.url.replace('/payment-complete', '/pages/payment-complete')
                } else if (req.url.startsWith('/studio')) {
                    const studioUrl = new URL(req.url, 'http://localhost')
                    if (studioUrl.pathname === '/studio' || studioUrl.pathname === '/studio/') {
                        req.url = `/pages/studio/index.html${studioUrl.search}`
                    }
                }
                next()
            })
        }
    }
}

export default defineConfig(({ mode }) => {
    const serverEnvironment = loadEnv(mode, process.cwd(), '')
    for (const [key, value] of Object.entries(serverEnvironment)) {
        if (process.env[key] === undefined) process.env[key] = value
    }

    return {
        plugins: [
            bookingApiPlugin(),
            studioApiPlugin(),
            rewritePlugin(),
            viteStaticCopy({
                targets: [
                    { src: 'app/scripts/*', dest: 'app/scripts' },
                    { src: 'app/components/*', dest: 'app/components' },
                    { src: 'app/data/*', dest: 'app/data' },
                ],
            }),
        ],
        build: {
            rollupOptions: {
                input: {
                    main: resolve(__dirname, 'index.html'),
                    notFound: resolve(__dirname, '404.html'),
                    building: resolve(__dirname, 'pages/building/index.html'),
                    contact: resolve(__dirname, 'pages/contact/index.html'),
                    filmClub: resolve(__dirname, 'pages/film-club/index.html'),
                    makerspace: resolve(__dirname, 'pages/makerspace/index.html'),
                    paymentComplete: resolve(__dirname, 'pages/payment-complete/index.html'),
                    studio: resolve(__dirname, 'pages/studio/index.html'),
                    archiveV1: resolve(__dirname, 'archive/v1/index.html'),
                    archiveV1Building: resolve(__dirname, 'archive/v1/building/index.html'),
                    archiveV1Contact: resolve(__dirname, 'archive/v1/contact/index.html'),
                    archiveV1FilmClub: resolve(__dirname, 'archive/v1/film-club/index.html'),
                    archiveV1Makerspace: resolve(__dirname, 'archive/v1/makerspace/index.html'),
                },
            },
        },
    }
})
