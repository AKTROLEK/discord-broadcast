const express = require('express');
const os = require('os');

const { version } = require('../../package.json');
const { createLogger, formatNumber, formatTime } = require('../utils/helpers');

class DashboardServer {
    constructor(options) {
        const { config, broadcastManager, languageManager, clients } = options;

        this.config = config;
        this.broadcastManager = broadcastManager;
        this.languageManager = languageManager;
        this.clientsRef = clients;
        this.logger = createLogger('Dashboard');
        this.dashboardConfig = config.dashboard || { enabled: false };
        this.apiKey = this.dashboardConfig.apiKey || '';
        this.server = null;
        this.app = null;
    }

    start() {
        if (!this.dashboardConfig.enabled) {
            this.logger.info('Dashboard disabled via configuration. Skipping web server start.');
            return;
        }

        if (this.server) {
            this.logger.warn('Dashboard server is already running.');
            return;
        }

        const port = Number(this.dashboardConfig.port) || 3000;

        this.app = express();
        this.app.use(express.json());

        this.registerHealthRoute();
        this.registerAuthMiddleware();
        this.registerRoutes();

        this.server = this.app.listen(port, () => {
            this.logger.info(`Dashboard listening on port ${port}`);
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            this.logger.info('Dashboard server stopped');
            this.server = null;
        }
    }

    getClients() {
        return Array.isArray(this.clientsRef) ? this.clientsRef : [];
    }

    registerHealthRoute() {
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', uptime: process.uptime() });
        });
    }

    registerAuthMiddleware() {
        if (!this.apiKey) {
            this.logger.warn('Dashboard is running without an API key. Consider setting DASHBOARD_API_KEY for protection.');
            return;
        }

        this.app.use((req, res, next) => {
            if (req.path === '/health') {
                return next();
            }

            const headerKey = req.headers['x-api-key'];
            const authHeader = req.headers.authorization;
            const queryKey = req.query.key;

            let token = null;
            if (headerKey) token = headerKey;
            if (!token && typeof queryKey === 'string') token = queryKey;
            if (!token && authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.substring(7);
            }

            if (token === this.apiKey) {
                req.dashboardKey = token;
                return next();
            }

            res.status(401).send('Unauthorized. Provide a valid API key using the x-api-key header or ?key= query parameter.');
        });
    }

    registerRoutes() {
        this.app.get('/', (req, res) => {
            const key = this.apiKey ? req.dashboardKey : '';
            res.send(this.renderDashboardPage(key));
        });

        this.app.get('/api/status', (req, res) => {
            res.json(this.getStatusPayload());
        });
    }

    getStatusPayload() {
        const { stats, activeJobs, recentJobs, clientLoad } = this.broadcastManager.getDashboardState();
        const statsWithFormatting = {
            ...stats,
            uptimeFormatted: formatTime((stats?.uptime) || 0)
        };
        const loadLookup = new Map((clientLoad || []).map(({ clientId, load }) => [clientId, load]));

        const clients = this.getClients()
            .filter(client => client && client.user)
            .map(client => ({
                id: client.user.id,
                tag: client.user.tag,
                status: this.normalizeGatewayStatus(client.ws?.status),
                ping: typeof client.ws?.ping === 'number' ? Math.round(client.ws.ping) : null,
                guilds: client.guilds?.cache?.size || 0,
                readyAt: client.readyAt ? client.readyAt.toISOString() : null,
                uptime: typeof client.uptime === 'number' ? client.uptime : (client.readyAt ? Date.now() - client.readyAt.getTime() : null),
                load: loadLookup.get(client.user.id) || 0
            }));

        const memoryUsage = process.memoryUsage();
        const uptimeSeconds = process.uptime();
        const refreshInterval = this.dashboardConfig.refreshInterval || 5000;

        const languageData = {
            default: this.languageManager.getDefaultLanguageCode(),
            available: Object.keys(this.languageManager.getAllLanguages() || {})
        };

        return {
            version,
            stats: statsWithFormatting,
            activeJobs,
            recentJobs,
            clientLoad,
            clients,
            language: languageData,
            configuration: {
                guildId: this.config.server?.guildId || 'Not set',
                broadcastRoleId: this.config.server?.broadcastRoleId || 'Not set',
                reportChannelId: this.config.server?.reportChannelId || 'Not set'
            },
            system: {
                platform: process.platform,
                nodeVersion: process.version,
                hostname: os.hostname(),
                cpuCount: os.cpus()?.length || 0,
                uptimeSeconds,
                uptimeFormatted: formatTime(uptimeSeconds * 1000),
                memory: {
                    rss: memoryUsage.rss,
                    heapUsed: memoryUsage.heapUsed,
                    heapTotal: memoryUsage.heapTotal
                }
            },
            dashboard: {
                refreshInterval,
                protected: Boolean(this.apiKey)
            }
        };
    }

    renderDashboardPage(apiKey = '') {
        const data = this.getStatusPayload();
        const escape = this.escapeHtml;
        const refreshInterval = this.dashboardConfig.refreshInterval || 5000;

        const formatBytes = (bytes) => {
            if (!bytes || bytes <= 0) return '0 MB';
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        };

        const formatTimestampValue = (timestamp) => {
            if (!timestamp) return 'No broadcasts yet';
            const date = new Date(timestamp);
            if (Number.isNaN(date.getTime())) return 'No broadcasts yet';
            return date.toLocaleString();
        };

        const formatMessagePreviewValue = (message) => {
            if (!message) return 'Awaiting first dispatch';
            const trimmed = message.trim();
            if (!trimmed) return 'Awaiting first dispatch';
            return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
        };

        const lastBroadcastTime = formatTimestampValue(data.stats.lastBroadcastAt);
        const lastBroadcastMessage = formatMessagePreviewValue(data.stats.lastBroadcastMessage);

        const activeJobRows = data.activeJobs.length === 0
            ? '<tr><td colspan="6" class="empty">No active broadcasts</td></tr>'
            : data.activeJobs.map(job => `
                <tr>
                    <td>${escape(job.id)}</td>
                    <td>${escape(job.initiator || 'Unknown')}</td>
                    <td>${formatNumber(job.totalMembers || 0)}</td>
                    <td>${job.progress || 0}%</td>
                    <td>${escape(job.runtime || '0s')}</td>
                    <td>${escape(job.messagePreview || '')}</td>
                </tr>
            `).join('');

        const recentJobRows = data.recentJobs.length === 0
            ? '<tr><td colspan="6" class="empty">No recent broadcasts</td></tr>'
            : data.recentJobs.map(job => `
                <tr>
                    <td>${escape(job.id)}</td>
                    <td>${escape(job.initiator || 'Unknown')}</td>
                    <td>${formatNumber(job.totalMembers || 0)}</td>
                    <td>${formatNumber(job.success || 0)} / ${formatNumber(job.failure || 0)}</td>
                    <td>${escape(job.durationFormatted || '0s')}</td>
                    <td>${escape(job.messagePreview || '')}</td>
                </tr>
            `).join('');

        const clientRows = data.clients.length === 0
            ? '<tr><td colspan="7" class="empty">No connected clients</td></tr>'
            : data.clients.map(client => {
                const statusClass = client.status === 'READY' ? 'status-online' : client.status === 'DISCONNECTED' ? 'status-offline' : 'status-unknown';
                return `
                    <tr>
                        <td>${escape(client.tag)}</td>
                        <td>${escape(client.id)}</td>
                        <td><span class="status-indicator"><span class="${statusClass}"></span>${escape(client.status)}</span></td>
                        <td>${client.ping !== null && client.ping !== undefined ? `${client.ping} ms` : 'N/A'}</td>
                        <td>${formatNumber(client.load || 0)}</td>
                        <td>${formatNumber(client.guilds || 0)}</td>
                        <td>${client.readyAt ? escape(client.readyAt) : 'N/A'}</td>
                    </tr>
                `;
            }).join('');

        const languagePills = (data.language.available || []).length === 0
            ? '<span class="language-pill">default</span>'
            : data.language.available.map(lang => `<span class="language-pill">${escape(lang)}</span>`).join('');

        const maxClientLoad = data.clientLoad.reduce((max, entry) => {
            const load = typeof entry.load === 'number' ? entry.load : 0;
            return load > max ? load : max;
        }, 0) || 1;

        const clientLoadList = data.clientLoad.length === 0
            ? '<div class="empty">No workload data yet</div>'
            : data.clientLoad.map(entry => {
                const client = data.clients.find(c => c.id === entry.clientId);
                const label = client ? `${escape(client.tag)} • ${escape(client.id)}` : escape(entry.clientId);
                const load = typeof entry.load === 'number' ? entry.load : 0;
                const width = Math.min(100, Math.round((load / maxClientLoad) * 100));
                return `
                    <div class="load-item">
                        <div class="load-header">
                            <span>${label}</span>
                            <span>${formatNumber(load)}</span>
                        </div>
                        <div class="load-bar"><div class="load-bar-fill" style="width: ${width}%"></div></div>
                    </div>
                `;
            }).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Wick Broadcast Celestial Command</title>
    <style>
        :root {
            color-scheme: dark;
            font-family: 'Poppins', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #050312;
            color: #F8FAFF;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            padding: 36px 16px 60px;
            position: relative;
            overflow-x: hidden;
            background: radial-gradient(circle at 20% -20%, rgba(99, 102, 241, 0.35), transparent 55%),
                        radial-gradient(circle at 90% 10%, rgba(59, 130, 246, 0.25), transparent 60%),
                        linear-gradient(140deg, #03010A 0%, #04061B 55%, #050312 100%);
        }

        body::before,
        body::after {
            content: '';
            position: fixed;
            width: 1600px;
            height: 1600px;
            background: radial-gradient(circle, rgba(59, 130, 246, 0.12) 0%, transparent 65%);
            filter: blur(80px);
            opacity: 0.6;
            z-index: -3;
        }

        body::before {
            top: -1200px;
            left: -800px;
        }

        body::after {
            bottom: -1100px;
            right: -900px;
        }

        .starlight {
            position: fixed;
            inset: 0;
            pointer-events: none;
            z-index: -2;
            background-image: radial-gradient(2px 2px at 20% 20%, rgba(255, 255, 255, 0.12), transparent),
                              radial-gradient(1.5px 1.5px at 70% 40%, rgba(255, 255, 255, 0.18), transparent),
                              radial-gradient(1px 1px at 40% 80%, rgba(148, 163, 184, 0.35), transparent);
            animation: twinkle 12s infinite linear;
        }

        @keyframes twinkle {
            from { transform: translate3d(0, 0, 0) scale(1); opacity: 0.7; }
            50% { transform: translate3d(-10px, 20px, 0) scale(1.05); opacity: 1; }
            to { transform: translate3d(15px, -15px, 0) scale(0.98); opacity: 0.7; }
        }

        .page {
            width: min(1220px, 100%);
            position: relative;
        }

        .aurora {
            position: absolute;
            inset: -140px 0 auto;
            height: 320px;
            background: radial-gradient(circle at 15% 20%, rgba(192, 132, 252, 0.35), transparent 55%),
                        radial-gradient(circle at 70% 10%, rgba(59, 130, 246, 0.4), transparent 60%);
            filter: blur(60px);
            opacity: 0.75;
            pointer-events: none;
        }

        header.hero {
            position: relative;
            border-radius: 28px;
            padding: 36px;
            overflow: hidden;
            background: linear-gradient(135deg, rgba(15, 23, 42, 0.75), rgba(37, 99, 235, 0.12));
            border: 1px solid rgba(148, 163, 255, 0.22);
            box-shadow: 0 35px 65px rgba(8, 11, 30, 0.55);
        }

        .hero::before {
            content: '';
            position: absolute;
            inset: -120px;
            background: radial-gradient(circle at top right, rgba(59, 130, 246, 0.55), transparent 55%);
            opacity: 0.35;
            filter: blur(40px);
        }

        .hero::after {
            content: '';
            position: absolute;
            top: -140px;
            right: -80px;
            width: 420px;
            height: 420px;
            background: radial-gradient(circle, rgba(129, 140, 248, 0.28), rgba(99, 102, 241, 0));
            filter: blur(35px);
            opacity: 0.8;
        }

        .hero-grid {
            position: relative;
            display: grid;
            gap: 32px;
            align-items: start;
        }

        .hero-header {
            display: grid;
            gap: 14px;
        }

        .badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: fit-content;
            padding: 8px 18px;
            border-radius: 999px;
            text-transform: uppercase;
            letter-spacing: 0.16em;
            font-size: 11px;
            font-weight: 600;
            color: #C7D2FE;
            background: linear-gradient(120deg, rgba(99, 102, 241, 0.55), rgba(14, 165, 233, 0.35));
            border: 1px solid rgba(148, 163, 255, 0.35);
            backdrop-filter: blur(10px);
        }

        .hero h1 {
            margin: 0;
            font-size: clamp(30px, 5vw, 46px);
            font-weight: 700;
            color: #EEF2FF;
        }

        .hero p {
            margin: 0;
            max-width: 640px;
            color: rgba(226, 232, 240, 0.75);
            line-height: 1.7;
        }

        .status-band {
            display: flex;
            flex-wrap: wrap;
            gap: 14px;
        }

        .status-chip {
            position: relative;
            padding: 14px 18px;
            border-radius: 18px;
            background: rgba(15, 23, 42, 0.72);
            border: 1px solid rgba(99, 102, 241, 0.28);
            min-width: 180px;
            display: grid;
            gap: 6px;
            box-shadow: inset 0 0 0 1px rgba(148, 163, 255, 0.08);
        }

        .status-chip span.label {
            font-size: 11px;
            letter-spacing: 0.14em;
            color: rgba(148, 163, 255, 0.8);
            text-transform: uppercase;
        }

        .status-chip span.value {
            font-size: 16px;
            font-weight: 600;
            color: #F4F4FF;
        }

        main.content {
            margin-top: 36px;
            display: grid;
            gap: 28px;
        }

        .section {
            background: rgba(6, 11, 25, 0.92);
            border: 1px solid rgba(99, 102, 241, 0.16);
            border-radius: 26px;
            padding: 32px;
            box-shadow: 0 28px 60px rgba(5, 8, 20, 0.65);
            backdrop-filter: blur(18px);
        }

        .section-header {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 26px;
        }

        .section-header h2 {
            margin: 0;
            font-size: 24px;
            font-weight: 600;
            color: #E5E7FF;
        }

        .section-subtitle {
            color: rgba(148, 163, 184, 0.8);
            font-size: 14px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
            gap: 20px;
        }

        .stat-card {
            position: relative;
            padding: 20px 18px;
            border-radius: 22px;
            background: linear-gradient(160deg, rgba(30, 41, 59, 0.92), rgba(17, 24, 39, 0.88));
            border: 1px solid rgba(99, 102, 241, 0.26);
            overflow: hidden;
            display: grid;
            gap: 10px;
        }

        .stat-card::before {
            content: '';
            position: absolute;
            inset: -60% 40% auto -25%;
            height: 220px;
            background: radial-gradient(circle, rgba(79, 70, 229, 0.35), transparent 65%);
            opacity: 0.65;
        }

        .stat-label {
            font-size: 12px;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: rgba(191, 219, 254, 0.78);
            z-index: 1;
        }

        .stat-value {
            font-size: 28px;
            font-weight: 700;
            color: #FFFFFF;
            z-index: 1;
        }

        .stat-trend {
            font-size: 13px;
            color: rgba(148, 163, 184, 0.78);
            z-index: 1;
        }

        .panels-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 22px;
        }

        .holo-panel {
            background: rgba(15, 23, 42, 0.65);
            border: 1px solid rgba(148, 163, 255, 0.2);
            border-radius: 22px;
            padding: 22px;
            display: grid;
            gap: 12px;
            position: relative;
            overflow: hidden;
        }

        .holo-panel::after {
            content: '';
            position: absolute;
            inset: 12px -80px -80px 30%;
            background: radial-gradient(circle, rgba(59, 130, 246, 0.22), transparent 70%);
            opacity: 0.6;
        }

        .panel-title {
            font-size: 13px;
            letter-spacing: 0.14em;
            text-transform: uppercase;
            color: rgba(148, 163, 255, 0.78);
        }

        .panel-value {
            font-size: 19px;
            font-weight: 600;
            color: #F4F4FF;
            z-index: 1;
        }

        .language-list {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            z-index: 1;
        }

        .language-pill {
            padding: 6px 14px;
            border-radius: 999px;
            background: rgba(59, 130, 246, 0.2);
            color: #BFDBFE;
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            border: 1px solid rgba(148, 163, 255, 0.3);
        }

        .operations-grid {
            display: grid;
            gap: 24px;
        }

        .operations-split {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 24px;
        }

        .glass-card {
            background: rgba(10, 16, 32, 0.75);
            border-radius: 20px;
            border: 1px solid rgba(99, 102, 241, 0.18);
            padding: 22px;
            box-shadow: inset 0 0 0 1px rgba(148, 163, 255, 0.08);
            display: grid;
            gap: 16px;
        }

        .table-wrapper {
            overflow-x: auto;
            border-radius: 16px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            overflow: hidden;
            border-radius: 16px;
            background: rgba(2, 6, 23, 0.55);
        }

        thead {
            background: rgba(30, 41, 59, 0.6);
        }

        th, td {
            padding: 14px 16px;
            text-align: left;
            font-size: 13px;
        }

        th {
            text-transform: uppercase;
            letter-spacing: 0.12em;
            font-weight: 600;
            color: rgba(148, 163, 255, 0.78);
        }

        tbody tr:nth-child(odd) {
            background: rgba(8, 12, 32, 0.45);
        }

        tbody tr:nth-child(even) {
            background: rgba(6, 10, 28, 0.35);
        }

        tbody td {
            color: rgba(226, 232, 240, 0.92);
        }

        tbody tr:hover {
            background: rgba(59, 130, 246, 0.14);
        }

        .empty {
            text-align: center;
            color: rgba(148, 163, 184, 0.75);
        }

        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .status-indicator span {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            display: inline-block;
            box-shadow: 0 0 12px currentColor;
        }

        .status-online { color: #34D399; background: currentColor; }
        .status-offline { color: #F87171; background: currentColor; }
        .status-unknown { color: #FBBF24; background: currentColor; }

        .load-list {
            display: grid;
            gap: 16px;
        }

        .load-item {
            display: grid;
            gap: 8px;
        }

        .load-header {
            display: flex;
            justify-content: space-between;
            font-size: 13px;
            color: rgba(191, 219, 254, 0.9);
        }

        .load-bar {
            height: 12px;
            border-radius: 999px;
            background: rgba(30, 41, 59, 0.82);
            overflow: hidden;
        }

        .load-bar-fill {
            height: 100%;
            border-radius: 999px;
            background: linear-gradient(90deg, rgba(14, 165, 233, 0.85), rgba(99, 102, 241, 0.95));
            transition: width 0.4s ease;
        }

        footer.page-footer {
            margin-top: 32px;
            text-align: center;
            font-size: 12px;
            letter-spacing: 0.14em;
            color: rgba(148, 163, 184, 0.75);
        }

        @media (max-width: 768px) {
            body {
                padding: 24px 12px 48px;
            }

            header.hero {
                padding: 28px;
            }

            .section {
                padding: 24px;
            }

            table {
                display: block;
                overflow-x: auto;
            }
        }
    </style>
</head>
<body>
    <div class="starlight"></div>
    <div class="page">
        <div class="aurora"></div>
        <header class="hero">
            <div class="hero-grid">
                <div class="hero-header">
                    <span class="badge">Live Command Bridge</span>
                    <h1>Wick Broadcast Celestial Command</h1>
                    <p>لوحة تحكم مستقبلية تضع قوة بث رسائلك بين يديك. راقب أداء الأسطول، استشعر حالة العملاء، وتابع نبض المنظومة بلغة فاخرة مستوحاة من رحلات الفضاء.</p>
                </div>
                <div class="status-band">
                    <div class="status-chip">
                        <span class="label">Version</span>
                        <span class="value" id="version-label">${escape(data.version)}</span>
                    </div>
                    <div class="status-chip">
                        <span class="label">Default Language</span>
                        <span class="value" id="default-language">${escape(data.language.default)}</span>
                    </div>
                    <div class="status-chip">
                        <span class="label">Last Sync</span>
                        <span class="value" id="last-updated">Just now</span>
                    </div>
                </div>
            </div>
        </header>

        <main class="content">
            <section class="section">
                <div class="section-header">
                    <h2>Mission Metrics</h2>
                    <span class="section-subtitle">نبض الحملات اللحظي، بأناقة الدرجة الأولى</span>
                </div>
                <div class="stats-grid">
                    <article class="stat-card">
                        <span class="stat-label">Total Broadcasts</span>
                        <span class="stat-value" id="total-broadcasts">${formatNumber(data.stats.totalBroadcasts)}</span>
                        <span class="stat-trend">إجمالي الرحلات الناجزة</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Members Reached</span>
                        <span class="stat-value" id="total-members">${formatNumber(data.stats.totalMembersTargeted)}</span>
                        <span class="stat-trend">مستلمو الإشعارات عبر الأسطول</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Success Rate</span>
                        <span class="stat-value" id="success-rate">${data.stats.successRate || 0}%</span>
                        <span class="stat-trend">نسبة التسليم المؤكّد</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Successful Deliveries</span>
                        <span class="stat-value" id="success-total">${formatNumber(data.stats.totalSuccess || 0)}</span>
                        <span class="stat-trend">رسائل وصلت لوجهتها</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Failed Attempts</span>
                        <span class="stat-value" id="failure-total">${formatNumber(data.stats.totalFailures || 0)}</span>
                        <span class="stat-trend">محاولات تحتاج مراجعة</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Active Clients</span>
                        <span class="stat-value" id="client-count">${formatNumber(data.clients.length)}</span>
                        <span class="stat-trend">عدد العملاء المتأهبين</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Active Broadcasts</span>
                        <span class="stat-value" id="active-job-count">${formatNumber(data.activeJobs.length)}</span>
                        <span class="stat-trend">جلسات البث الجارية</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">System Uptime</span>
                        <span class="stat-value" id="bot-uptime">${data.stats.uptimeFormatted}</span>
                        <span class="stat-trend">مدة التشغيل منذ الإقلاع</span>
                    </article>
                </div>
            </section>

            <section class="section">
                <div class="section-header">
                    <h2>Broadcast Insights</h2>
                    <span class="section-subtitle">إحصاءات فورية لتوجّه الأسطول</span>
                </div>
                <div class="panels-grid">
                    <div class="holo-panel">
                        <span class="panel-title">Last Broadcast</span>
                        <span class="panel-value" id="last-broadcast-time">${escape(lastBroadcastTime)}</span>
                    </div>
                    <div class="holo-panel">
                        <span class="panel-title">Last Message Preview</span>
                        <span class="panel-value" id="last-broadcast-message">${escape(lastBroadcastMessage)}</span>
                    </div>
                    <div class="holo-panel">
                        <span class="panel-title">Language Availability</span>
                        <div class="language-list" id="language-list">${languagePills}</div>
                    </div>
                    <div class="holo-panel">
                        <span class="panel-title">Dashboard Security</span>
                        <span class="panel-value">${this.apiKey ? '🔐 Protected with API Key' : '⚠️ Public Access (configure DASHBOARD_API_KEY)'}</span>
                    </div>
                </div>
            </section>

            <section class="section">
                <div class="section-header">
                    <h2>Fleet Operations</h2>
                    <span class="section-subtitle">إدارة العملاء وتوزيع الأحمال عبر الفضاء الرقمي</span>
                </div>
                <div class="operations-grid">
                    <div class="glass-card">
                        <h3>Client Constellation</h3>
                        <div class="table-wrapper">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Tag</th>
                                        <th>Client ID</th>
                                        <th>Status</th>
                                        <th>Ping</th>
                                        <th>Load</th>
                                        <th>Guilds</th>
                                        <th>Ready Since</th>
                                    </tr>
                                </thead>
                                <tbody id="clients-body">
                                    ${clientRows}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div class="operations-split">
                        <div class="glass-card">
                            <h3>Load Distribution</h3>
                            <div class="load-list" id="client-load-list">${clientLoadList}</div>
                        </div>
                        <div class="glass-card">
                            <h3>Active Broadcasts</h3>
                            <div class="table-wrapper">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>ID</th>
                                            <th>Initiator</th>
                                            <th>Members</th>
                                            <th>Progress</th>
                                            <th>Runtime</th>
                                            <th>Preview</th>
                                        </tr>
                                    </thead>
                                    <tbody id="active-jobs-body">
                                        ${activeJobRows}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <div class="glass-card">
                            <h3>Recent Broadcasts</h3>
                            <div class="table-wrapper">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>ID</th>
                                            <th>Initiator</th>
                                            <th>Members</th>
                                            <th>Success / Fail</th>
                                            <th>Duration</th>
                                            <th>Preview</th>
                                        </tr>
                                    </thead>
                                    <tbody id="recent-jobs-body">
                                        ${recentJobRows}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section class="section">
                <div class="section-header">
                    <h2>System Health</h2>
                    <span class="section-subtitle">المقاييس الحيوية للمضيف</span>
                </div>
                <div class="panels-grid">
                    <div class="holo-panel">
                        <span class="panel-title">Node Version</span>
                        <span class="panel-value" id="node-version">${escape(process.version)}</span>
                    </div>
                    <div class="holo-panel">
                        <span class="panel-title">Hostname</span>
                        <span class="panel-value" id="hostname">${escape(os.hostname())}</span>
                    </div>
                    <div class="holo-panel">
                        <span class="panel-title">Process Uptime</span>
                        <span class="panel-value" id="process-uptime">${formatTime(process.uptime() * 1000)}</span>
                    </div>
                    <div class="holo-panel">
                        <span class="panel-title">Memory Usage</span>
                        <span class="panel-value" id="memory-usage">${formatBytes(process.memoryUsage().heapUsed)} / ${formatBytes(process.memoryUsage().heapTotal)}</span>
                    </div>
                </div>
            </section>
        </main>

        <footer class="page-footer">
            Wick Studio Broadcast System • ${this.apiKey ? '🔐 API Key Protection Enabled' : '⚠️ API Key Not Configured'} • Crafted for interstellar operations
        </footer>
    </div>

    <script>
        const API_KEY = ${this.apiKey ? `'${escape(apiKey)}'` : 'null'};
        const REFRESH_INTERVAL = ${refreshInterval};

        const escapeHtml = (value) => {
            if (value === undefined || value === null) return '';
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        };

        const setText = (id, value) => {
            const element = document.getElementById(id);
            if (element) element.textContent = value;
        };

        const formatNumber = (num) => {
            if (typeof num !== 'number') {
                num = Number(num) || 0;
            }
            return num.toLocaleString();
        };

        const formatBytes = (bytes) => {
            if (!bytes || bytes <= 0) return '0 MB';
            return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        };

        const formatTimestamp = (timestamp) => {
            if (!timestamp) return 'No broadcasts yet';
            const date = new Date(timestamp);
            if (Number.isNaN(date.getTime())) return 'No broadcasts yet';
            return date.toLocaleString();
        };

        const formatMessagePreview = (message) => {
            if (!message) return 'Awaiting first dispatch';
            const trimmed = message.trim();
            if (!trimmed) return 'Awaiting first dispatch';
            return trimmed.length > 120 ? trimmed.slice(0, 117) + '…' : trimmed;
        };

        const updateSummary = (data) => {
            setText('total-broadcasts', formatNumber(data.stats.totalBroadcasts));
            setText('total-members', formatNumber(data.stats.totalMembersTargeted));
            setText('success-rate', (data.stats.successRate || 0) + '%');
            setText('client-count', formatNumber(data.clients.length));
            setText('active-job-count', formatNumber(data.activeJobs.length));
            setText('bot-uptime', data.stats.uptimeFormatted || '0s');
            setText('success-total', formatNumber(data.stats.totalSuccess || 0));
            setText('failure-total', formatNumber(data.stats.totalFailures || 0));
            setText('version-label', data.version);
            setText('default-language', data.language.default);
        };

        const updateLastBroadcast = (stats) => {
            setText('last-broadcast-time', formatTimestamp(stats.lastBroadcastAt));
            setText('last-broadcast-message', formatMessagePreview(stats.lastBroadcastMessage));
        };

        const updateLanguages = (language) => {
            const container = document.getElementById('language-list');
            if (!container) return;

            if (!language.available || language.available.length === 0) {
                container.innerHTML = '<span class="language-pill">default</span>';
                return;
            }

            container.innerHTML = language.available
                .map(code => `<span class="language-pill">${escapeHtml(code)}</span>`)
                .join('');
        };

        const updateLastUpdated = () => {
            const now = new Date();
            setText('last-updated', now.toLocaleTimeString());
        };

        const renderRows = (containerId, rows) => {
            const container = document.getElementById(containerId);
            if (container) {
                container.innerHTML = rows;
            }
        };

        const renderClients = (clients) => {
            if (!Array.isArray(clients) || clients.length === 0) {
                renderRows('clients-body', '<tr><td colspan="7" class="empty">No connected clients</td></tr>');
                return;
            }

            const rows = clients.map(client => {
                const statusClass = client.status === 'READY' ? 'status-online' : client.status === 'DISCONNECTED' ? 'status-offline' : 'status-unknown';
                return `
                    <tr>
                        <td>${escapeHtml(client.tag)}</td>
                        <td>${escapeHtml(client.id)}</td>
                        <td><span class="status-indicator"><span class="${statusClass}"></span>${escapeHtml(client.status)}</span></td>
                        <td>${client.ping !== null && client.ping !== undefined ? escapeHtml(client.ping + ' ms') : 'N/A'}</td>
                        <td>${formatNumber(client.load || 0)}</td>
                        <td>${formatNumber(client.guilds || 0)}</td>
                        <td>${client.readyAt ? escapeHtml(client.readyAt) : 'N/A'}</td>
                    </tr>
                `;
            }).join('');

            renderRows('clients-body', rows);
        };

        const renderClientLoad = (clients, load) => {
            const container = document.getElementById('client-load-list');
            if (!container) return;

            if (!Array.isArray(load) || load.length === 0) {
                container.innerHTML = '<div class="empty">No workload data yet</div>';
                return;
            }

            const maxLoad = load.reduce((max, item) => item.load > max ? item.load : max, 0) || 1;

            container.innerHTML = load.map(entry => {
                const client = clients.find(client => client.id === entry.clientId);
                const label = client ? `${escapeHtml(client.tag)} • ${escapeHtml(client.id)}` : escapeHtml(entry.clientId);
                const width = Math.min(100, Math.round(((entry.load || 0) / maxLoad) * 100));

                return `
                    <div class="load-item">
                        <div class="load-header">
                            <span>${label}</span>
                            <span>${formatNumber(entry.load || 0)}</span>
                        </div>
                        <div class="load-bar"><div class="load-bar-fill" style="width: ${width}%"></div></div>
                    </div>
                `;
            }).join('');
        };

        const renderActiveJobs = (jobs) => {
            if (!Array.isArray(jobs) || jobs.length === 0) {
                renderRows('active-jobs-body', '<tr><td colspan="6" class="empty">No active broadcasts</td></tr>');
                return;
            }

            const rows = jobs.map(job => `
                <tr>
                    <td>${escapeHtml(job.id)}</td>
                    <td>${escapeHtml(job.initiator || 'Unknown')}</td>
                    <td>${formatNumber(job.totalMembers || 0)}</td>
                    <td>${(job.progress || 0)}%</td>
                    <td>${escapeHtml(job.runtime || '0s')}</td>
                    <td>${escapeHtml(job.messagePreview || '')}</td>
                </tr>
            `).join('');

            renderRows('active-jobs-body', rows);
        };

        const renderRecentJobs = (jobs) => {
            if (!Array.isArray(jobs) || jobs.length === 0) {
                renderRows('recent-jobs-body', '<tr><td colspan="6" class="empty">No recent broadcasts</td></tr>');
                return;
            }

            const rows = jobs.map(job => `
                <tr>
                    <td>${escapeHtml(job.id)}</td>
                    <td>${escapeHtml(job.initiator || 'Unknown')}</td>
                    <td>${formatNumber(job.totalMembers || 0)}</td>
                    <td>${formatNumber(job.success || 0)} / ${formatNumber(job.failure || 0)}</td>
                    <td>${escapeHtml(job.durationFormatted || '0s')}</td>
                    <td>${escapeHtml(job.messagePreview || '')}</td>
                </tr>
            `).join('');

            renderRows('recent-jobs-body', rows);
        };

        const updateSystem = (system) => {
            setText('node-version', system.nodeVersion);
            setText('hostname', system.hostname);
            setText('process-uptime', system.uptimeFormatted);
            setText('memory-usage', formatBytes(system.memory.heapUsed) + ' / ' + formatBytes(system.memory.heapTotal));
        };

        const refreshDashboard = async () => {
            try {
                const query = API_KEY ? ('?key=' + encodeURIComponent(API_KEY)) : '';
                const response = await fetch('/api/status' + query);
                if (!response.ok) {
                    throw new Error('Failed to fetch dashboard status');
                }

                const payload = await response.json();
                payload.stats.uptimeFormatted = payload.stats.uptime ? formatDuration(payload.stats.uptime) : '0s';

                updateSummary(payload);
                updateLastBroadcast(payload.stats);
                updateLanguages(payload.language);
                renderClients(payload.clients);
                renderClientLoad(payload.clients, payload.clientLoad);
                renderActiveJobs(payload.activeJobs);
                renderRecentJobs(payload.recentJobs);
                updateSystem(payload.system);
                updateLastUpdated();
            } catch (error) {
                console.error('Dashboard refresh failed:', error);
            }
        };

        const formatDuration = (milliseconds) => {
            if (!milliseconds || milliseconds <= 0) return '0s';
            const seconds = Math.floor((milliseconds / 1000) % 60);
            const minutes = Math.floor((milliseconds / (1000 * 60)) % 60);
            const hours = Math.floor((milliseconds / (1000 * 60 * 60)) % 24);
            const days = Math.floor(milliseconds / (1000 * 60 * 60 * 24));

            const parts = [];
            if (days) parts.push(days + 'd');
            if (hours) parts.push(hours + 'h');
            if (minutes) parts.push(minutes + 'm');
            if (seconds || parts.length === 0) parts.push(seconds + 's');
            return parts.join(' ');
        };

        setInterval(refreshDashboard, REFRESH_INTERVAL);
        refreshDashboard();
    </script>
</body>
</html>`;
    }

    normalizeGatewayStatus(status) {
        if (status === undefined || status === null) {
            return 'UNKNOWN';
        }

        if (typeof status === 'string') {
            return status.toUpperCase();
        }

        switch (status) {
            case 0:
                return 'READY';
            case 1:
                return 'CONNECTING';
            case 2:
                return 'RECONNECTING';
            case 3:
                return 'IDLE';
            case 4:
                return 'NEARLY';
            case 5:
                return 'DISCONNECTED';
            default:
                return 'UNKNOWN';
        }
    }

    escapeHtml(value) {
        if (value === undefined || value === null) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

module.exports = DashboardServer;
