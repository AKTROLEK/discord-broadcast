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
    <title>Wick Broadcast Command Center</title>
    <style>
        :root {
            color-scheme: dark;
            font-family: 'Poppins', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: #060714;
            color: #F9FAFB;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            min-height: 100vh;
            background: radial-gradient(circle at top, rgba(88, 101, 242, 0.35), transparent 55%),
                        radial-gradient(circle at bottom, rgba(37, 99, 235, 0.18), transparent 60%),
                        #05060f;
            display: flex;
            justify-content: center;
            padding: 32px 16px 48px;
        }

        .page {
            width: min(1200px, 100%);
            position: relative;
        }

        .glow {
            position: absolute;
            inset: -80px -120px auto;
            height: 280px;
            background: radial-gradient(circle, rgba(88, 101, 242, 0.65), rgba(88, 101, 242, 0));
            filter: blur(60px);
            opacity: 0.6;
            pointer-events: none;
        }

        header.hero {
            position: relative;
            background: linear-gradient(135deg, rgba(88, 101, 242, 0.18), rgba(17, 24, 39, 0.95));
            border: 1px solid rgba(99, 102, 241, 0.35);
            border-radius: 20px;
            padding: 28px 32px;
            overflow: hidden;
            box-shadow: 0 25px 60px rgba(17, 24, 39, 0.45);
        }

        .hero::before {
            content: '';
            position: absolute;
            inset: -60px;
            background: radial-gradient(circle at top right, rgba(139, 92, 246, 0.25), transparent 60%);
            opacity: 0.8;
        }

        .hero-content {
            position: relative;
            display: grid;
            gap: 16px;
        }

        .badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            font-weight: 600;
            color: #C7D2FE;
            padding: 6px 14px;
            border-radius: 999px;
            background: linear-gradient(120deg, rgba(99, 102, 241, 0.35), rgba(59, 130, 246, 0.35));
            backdrop-filter: blur(8px);
        }

        .hero h1 {
            margin: 0;
            font-size: clamp(28px, 4vw, 40px);
            font-weight: 700;
            color: #F4F4FF;
        }

        .hero p {
            margin: 0;
            color: #9CA3AF;
            max-width: 620px;
            line-height: 1.6;
        }

        .hero-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 16px;
            margin-top: 8px;
        }

        .meta-tile {
            background: rgba(15, 23, 42, 0.55);
            border: 1px solid rgba(148, 163, 184, 0.2);
            border-radius: 12px;
            padding: 12px 16px;
            display: grid;
            gap: 4px;
            min-width: 160px;
        }

        .meta-label {
            font-size: 12px;
            text-transform: uppercase;
            color: #94A3B8;
            letter-spacing: 0.08em;
        }

        .meta-value {
            font-size: 16px;
            font-weight: 600;
            color: #E0E7FF;
        }

        main.content {
            margin-top: 32px;
            display: grid;
            gap: 24px;
        }

        .section {
            background: rgba(9, 13, 24, 0.9);
            border: 1px solid rgba(148, 163, 184, 0.12);
            border-radius: 20px;
            padding: 24px 28px;
            box-shadow: 0 20px 45px rgba(2, 6, 23, 0.45);
        }

        .section-header {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 20px;
        }

        .section-header h2 {
            margin: 0;
            font-size: 22px;
            font-weight: 600;
            color: #E0E7FF;
        }

        .section-subtitle {
            color: #64748B;
            font-size: 14px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 18px;
        }

        .stat-card {
            background: linear-gradient(145deg, rgba(30, 41, 59, 0.92), rgba(15, 23, 42, 0.92));
            border: 1px solid rgba(99, 102, 241, 0.14);
            border-radius: 16px;
            padding: 18px;
            display: grid;
            gap: 8px;
            position: relative;
            overflow: hidden;
        }

        .stat-card::after {
            content: '';
            position: absolute;
            inset: auto -40% 10% 50%;
            height: 120px;
            background: radial-gradient(circle, rgba(79, 70, 229, 0.32), transparent 70%);
            opacity: 0.75;
        }

        .stat-label {
            font-size: 13px;
            color: #94A3B8;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }

        .stat-value {
            font-size: 30px;
            font-weight: 700;
            color: #F8FAFC;
        }

        .stat-trend {
            font-size: 13px;
            color: #6EE7B7;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 8px;
            overflow: hidden;
            border-radius: 14px;
        }

        table thead {
            background: rgba(30, 41, 59, 0.75);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            font-size: 12px;
        }

        table th, table td {
            padding: 14px;
            text-align: left;
            border-bottom: 1px solid rgba(148, 163, 184, 0.08);
        }

        table tbody tr {
            background: rgba(15, 23, 42, 0.55);
        }

        table tbody tr:nth-child(even) {
            background: rgba(15, 23, 42, 0.45);
        }

        table tbody tr:hover {
            background: rgba(99, 102, 241, 0.18);
            transition: background 0.2s ease;
        }

        .empty {
            text-align: center;
            color: #94A3B8;
            padding: 18px;
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
        }

        .status-online {
            background: #34D399;
            box-shadow: 0 0 8px rgba(52, 211, 153, 0.65);
        }

        .status-offline {
            background: #F87171;
            box-shadow: 0 0 8px rgba(248, 113, 113, 0.55);
        }

        .status-unknown {
            background: #FBBF24;
            box-shadow: 0 0 8px rgba(251, 191, 36, 0.45);
        }

        .dual-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 24px;
        }

        .insight-grid {
            display: grid;
            gap: 16px;
        }

        .insight-tile {
            background: rgba(15, 23, 42, 0.62);
            border: 1px solid rgba(148, 163, 184, 0.14);
            border-radius: 14px;
            padding: 16px 18px;
        }

        .insight-label {
            font-size: 12px;
            color: #94A3B8;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }

        .insight-value {
            margin-top: 6px;
            font-size: 18px;
            color: #E2E8F0;
            font-weight: 600;
        }

        .language-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: rgba(59, 130, 246, 0.2);
            color: #BFDBFE;
            padding: 6px 12px;
            border-radius: 999px;
            font-size: 12px;
        }

        .language-list {
            margin-top: 10px;
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
        }

        .language-pill {
            padding: 4px 10px;
            border-radius: 999px;
            background: rgba(148, 163, 184, 0.16);
            color: #E2E8F0;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .load-list {
            display: grid;
            gap: 14px;
        }

        .load-item {
            display: grid;
            gap: 8px;
        }

        .load-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            color: #CBD5F5;
            font-size: 13px;
        }

        .load-bar {
            height: 10px;
            border-radius: 999px;
            background: rgba(30, 41, 59, 0.8);
            overflow: hidden;
            position: relative;
        }

        .load-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, rgba(59, 130, 246, 0.8), rgba(99, 102, 241, 0.95));
            border-radius: 999px;
            transition: width 0.35s ease;
        }

        footer.page-footer {
            text-align: center;
            color: #6B7280;
            font-size: 12px;
            margin-top: 24px;
            letter-spacing: 0.06em;
        }

        @media (max-width: 768px) {
            body {
                padding: 20px 12px 32px;
            }

            header.hero {
                padding: 24px;
            }

            .section {
                padding: 20px;
            }

            table {
                display: block;
                overflow-x: auto;
                border-radius: 12px;
            }
        }
    </style>
</head>
<body>
    <div class="page">
        <div class="glow"></div>
        <header class="hero">
            <div class="hero-content">
                <span class="badge">Live Command Center</span>
                <h1>Wick Broadcast Command Center</h1>
                <p>راقب بث الرسائل من بوتاتك على ديسكورد بدقة متناهية. تحكم كامل بحالة البث، أداء العملاء، وصحة المنظومة في تجربة فاخرة من الدرجة الأولى.</p>
                <div class="hero-meta">
                    <div class="meta-tile">
                        <span class="meta-label">Version</span>
                        <span class="meta-value" id="version-label">${escape(data.version)}</span>
                    </div>
                    <div class="meta-tile">
                        <span class="meta-label">Default Language</span>
                        <span class="meta-value"><span class="language-badge" id="default-language">${escape(data.language.default)}</span></span>
                    </div>
                    <div class="meta-tile">
                        <span class="meta-label">Last Updated</span>
                        <span class="meta-value" id="last-updated">Just now</span>
                    </div>
                </div>
            </div>
        </header>

        <main class="content">
            <section class="section">
                <div class="section-header">
                    <h2>Mission Metrics</h2>
                    <span class="section-subtitle">مؤشرات الأداء اللحظية لرحلات البث الخاصة بك</span>
                </div>
                <div class="stats-grid">
                    <article class="stat-card">
                        <span class="stat-label">Total Broadcasts</span>
                        <span class="stat-value" id="total-broadcasts">${formatNumber(data.stats.totalBroadcasts)}</span>
                        <span class="stat-trend">إجمالي الحملات المكتملة</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Members Reached</span>
                        <span class="stat-value" id="total-members">${formatNumber(data.stats.totalMembersTargeted)}</span>
                        <span class="stat-trend">مستلمو الرسائل عبر جميع العملاء</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Success Rate</span>
                        <span class="stat-value" id="success-rate">${data.stats.successRate || 0}%</span>
                        <span class="stat-trend">نسبة التسليم الناجح</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Successful Deliveries</span>
                        <span class="stat-value" id="success-total">${formatNumber(data.stats.totalSuccess || 0)}</span>
                        <span class="stat-trend">عدد الرسائل المرسلة بنجاح</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Failed Attempts</span>
                        <span class="stat-value" id="failure-total">${formatNumber(data.stats.totalFailures || 0)}</span>
                        <span class="stat-trend">محاولات لم تصل إلى الأعضاء</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Active Clients</span>
                        <span class="stat-value" id="client-count">${formatNumber(data.clients.length)}</span>
                        <span class="stat-trend">عدد العملاء الجاهزين للبث</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">Active Broadcasts</span>
                        <span class="stat-value" id="active-job-count">${formatNumber(data.activeJobs.length)}</span>
                        <span class="stat-trend">جلسات البث الجارية الآن</span>
                    </article>
                    <article class="stat-card">
                        <span class="stat-label">System Uptime</span>
                        <span class="stat-value" id="bot-uptime">${data.stats.uptimeFormatted}</span>
                        <span class="stat-trend">مدة تشغيل النظام منذ الإقلاع</span>
                    </article>
                </div>
            </section>

            <section class="section">
                <div class="section-header">
                    <h2>Broadcast Insights</h2>
                    <span class="section-subtitle">نظرة فورية على آخر الأحداث</span>
                </div>
                <div class="dual-grid">
                    <div class="insight-grid">
                        <div class="insight-tile">
                            <span class="insight-label">Last Broadcast</span>
                            <span class="insight-value" id="last-broadcast-time">${escape(lastBroadcastTime)}</span>
                        </div>
                        <div class="insight-tile">
                            <span class="insight-label">Last Message Preview</span>
                            <span class="insight-value" id="last-broadcast-message">${escape(lastBroadcastMessage)}</span>
                        </div>
                    </div>
                    <div class="insight-grid">
                        <div class="insight-tile">
                            <span class="insight-label">Language Availability</span>
                            <div class="language-list" id="language-list">${languagePills}</div>
                        </div>
                        <div class="insight-tile">
                            <span class="insight-label">Dashboard Security</span>
                            <span class="insight-value">${this.apiKey ? '🔐 Protected with API Key' : '⚠️ Running without API protection'}</span>
                        </div>
                    </div>
                </div>
            </section>

            <section class="section">
                <div class="section-header">
                    <h2>Connected Clients</h2>
                    <span class="section-subtitle">حالة عملائك المتعددين وتوزيع الحمل</span>
                </div>
                <div class="dual-grid">
                    <div>
                        <table>
                            <thead>
                                <tr>
                                    <th>Tag</th>
                                    <th>ID</th>
                                    <th>Status</th>
                                    <th>Ping</th>
                                    <th>Load</th>
                                    <th>Guilds</th>
                                    <th>Ready At</th>
                                </tr>
                            </thead>
                            <tbody id="clients-body">
                                ${clientRows}
                            </tbody>
                        </table>
                    </div>
                    <div class="insight-grid">
                        <div class="insight-tile">
                            <span class="insight-label">Load Balancing Pulse</span>
                            <div class="load-list" id="client-load-list">${clientLoadList}</div>
                        </div>
                    </div>
                </div>
            </section>

            <section class="section">
                <div class="section-header">
                    <h2>Broadcast Operations</h2>
                    <span class="section-subtitle">تابع الجلسات الحالية وتاريخ البث</span>
                </div>
                <div class="dual-grid">
                    <div>
                        <h3 style="margin:0 0 10px 0;color:#CBD5F5;font-weight:600;">Active Broadcast Jobs</h3>
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
                    <div>
                        <h3 style="margin:0 0 10px 0;color:#CBD5F5;font-weight:600;">Recent Broadcast History</h3>
                        <table>
                            <thead>
                                <tr>
                                    <th>ID</th>
                                    <th>Initiator</th>
                                    <th>Members</th>
                                    <th>Success / Failed</th>
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
            </section>

            <section class="section">
                <div class="section-header">
                    <h2>System Health</h2>
                    <span class="section-subtitle">المقاييس الحيوية لمضيف البوت</span>
                </div>
                <div class="insight-grid">
                    <div class="insight-tile">
                        <span class="insight-label">Node Version</span>
                        <span class="insight-value" id="node-version">${escape(process.version)}</span>
                    </div>
                    <div class="insight-tile">
                        <span class="insight-label">Hostname</span>
                        <span class="insight-value" id="hostname">${escape(os.hostname())}</span>
                    </div>
                    <div class="insight-tile">
                        <span class="insight-label">Process Uptime</span>
                        <span class="insight-value" id="process-uptime">${formatTime(process.uptime() * 1000)}</span>
                    </div>
                    <div class="insight-tile">
                        <span class="insight-label">Memory Usage</span>
                        <span class="insight-value" id="memory-usage">${formatBytes(process.memoryUsage().heapUsed)} / ${formatBytes(process.memoryUsage().heapTotal)}</span>
                    </div>
                </div>
            </section>
        </main>

        <footer class="page-footer">
            Wick Studio Broadcast System • ${this.apiKey ? '🔐 API Key Protection Enabled' : '⚠️ API Key Not Configured'} • Crafted for elite operations
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
