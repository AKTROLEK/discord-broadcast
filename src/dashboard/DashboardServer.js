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
            : data.clients.map(client => `
                <tr>
                    <td>${escape(client.tag)}</td>
                    <td>${escape(client.id)}</td>
                    <td>${escape(client.status)}</td>
                    <td>${client.ping !== null ? `${client.ping} ms` : 'N/A'}</td>
                    <td>${client.load || 0}</td>
                    <td>${client.guilds}</td>
                    <td>${client.readyAt ? escape(client.readyAt) : 'N/A'}</td>
                </tr>
            `).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Wick Broadcast Dashboard</title>
    <style>
        :root {
            color-scheme: dark;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: #111827;
            color: #F9FAFB;
        }

        body {
            margin: 0;
            padding: 24px;
            background: linear-gradient(135deg, rgba(88, 101, 242, 0.2), rgba(17, 24, 39, 0.95));
        }

        h1 {
            margin-bottom: 4px;
        }

        .subtitle {
            color: #9CA3AF;
            margin-bottom: 24px;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px;
        }

        .card {
            background: rgba(15, 23, 42, 0.85);
            border: 1px solid rgba(88, 101, 242, 0.2);
            border-radius: 12px;
            padding: 16px;
            box-shadow: 0 8px 16px rgba(0, 0, 0, 0.25);
        }

        .card h2 {
            margin: 0 0 8px 0;
            font-size: 16px;
            font-weight: 600;
            color: #A5B4FC;
        }

        .card .value {
            font-size: 28px;
            font-weight: 700;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 16px;
        }

        table thead {
            background: rgba(37, 99, 235, 0.3);
        }

        table th, table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }

        table tbody tr:hover {
            background: rgba(88, 101, 242, 0.1);
        }

        .section {
            margin-top: 32px;
        }

        .section h2 {
            font-size: 22px;
            margin-bottom: 12px;
        }

        .empty {
            text-align: center;
            color: #9CA3AF;
            padding: 16px;
        }

        .tag {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 999px;
            background: rgba(59, 130, 246, 0.15);
            color: #BFDBFE;
            font-size: 12px;
        }

        .footer {
            margin-top: 32px;
            color: #6B7280;
            font-size: 12px;
            text-align: center;
        }

        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }

        .status-indicator span {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
        }

        .status-online {
            background: #34D399;
        }

        .status-offline {
            background: #F87171;
        }

        .status-unknown {
            background: #FBBF24;
        }

        @media (max-width: 768px) {
            body {
                padding: 16px;
            }

            table {
                font-size: 14px;
            }
        }
    </style>
</head>
<body>
    <h1>Wick Broadcast Dashboard</h1>
    <div class="subtitle">Version ${escape(data.version)} • Default language: <span class="tag" id="default-language">${escape(data.language.default)}</span></div>

    <div class="grid">
        <div class="card">
            <h2>Total Broadcasts</h2>
            <div class="value" id="total-broadcasts">${formatNumber(data.stats.totalBroadcasts)}</div>
        </div>
        <div class="card">
            <h2>Members Reached</h2>
            <div class="value" id="total-members">${formatNumber(data.stats.totalMembersTargeted)}</div>
        </div>
        <div class="card">
            <h2>Success Rate</h2>
            <div class="value" id="success-rate">${data.stats.successRate || 0}%</div>
        </div>
        <div class="card">
            <h2>Active Clients</h2>
            <div class="value" id="client-count">${data.clients.length}</div>
        </div>
        <div class="card">
            <h2>Active Broadcasts</h2>
            <div class="value" id="active-job-count">${data.activeJobs.length}</div>
        </div>
        <div class="card">
            <h2>Bot Uptime</h2>
            <div class="value" id="bot-uptime">${data.stats.uptimeFormatted}</div>
        </div>
    </div>

    <div class="section">
        <h2>Connected Clients</h2>
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

    <div class="section">
        <h2>Active Broadcast Jobs</h2>
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

    <div class="section">
        <h2>Recent Broadcast History</h2>
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

    <div class="section">
        <h2>System Health</h2>
        <div class="grid">
            <div class="card">
                <h2>Node.js Version</h2>
                <div class="value" id="node-version">${escape(data.system.nodeVersion)}</div>
            </div>
            <div class="card">
                <h2>Server Host</h2>
                <div class="value" id="hostname">${escape(data.system.hostname)}</div>
            </div>
            <div class="card">
                <h2>Process Uptime</h2>
                <div class="value" id="process-uptime">${escape(data.system.uptimeFormatted)}</div>
            </div>
            <div class="card">
                <h2>Memory Usage</h2>
                <div class="value" id="memory-usage">${formatBytes(data.system.memory.heapUsed)} / ${formatBytes(data.system.memory.heapTotal)}</div>
            </div>
        </div>
    </div>

    <div class="footer">
        Guild ID: ${escape(data.configuration.guildId)} • Broadcast role: ${escape(data.configuration.broadcastRoleId)} • Report channel: ${escape(data.configuration.reportChannelId)}<br />
        Dashboard ${data.dashboard.protected ? 'secured with an API key' : 'running without authentication'} • Refreshing every ${refreshInterval / 1000}s
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

        const updateSummary = (data) => {
            document.getElementById('total-broadcasts').textContent = formatNumber(data.stats.totalBroadcasts);
            document.getElementById('total-members').textContent = formatNumber(data.stats.totalMembersTargeted);
            document.getElementById('success-rate').textContent = (data.stats.successRate || 0) + '%';
            document.getElementById('client-count').textContent = data.clients.length;
            document.getElementById('active-job-count').textContent = data.activeJobs.length;
            document.getElementById('bot-uptime').textContent = data.stats.uptimeFormatted || '0s';
            document.getElementById('default-language').textContent = data.language.default;
        };

        const renderRows = (containerId, rows) => {
            document.getElementById(containerId).innerHTML = rows;
        };

        const renderClients = (clients) => {
            if (clients.length === 0) {
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
                        <td>${client.ping !== null ? escapeHtml(client.ping + ' ms') : 'N/A'}</td>
                        <td>${client.load || 0}</td>
                        <td>${client.guilds}</td>
                        <td>${client.readyAt ? escapeHtml(client.readyAt) : 'N/A'}</td>
                    </tr>
                `;
            }).join('');

            renderRows('clients-body', rows);
        };

        const renderActiveJobs = (jobs) => {
            if (jobs.length === 0) {
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
            if (jobs.length === 0) {
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
            document.getElementById('node-version').textContent = system.nodeVersion;
            document.getElementById('hostname').textContent = system.hostname;
            document.getElementById('process-uptime').textContent = system.uptimeFormatted;
            document.getElementById('memory-usage').textContent = formatBytes(system.memory.heapUsed) + ' / ' + formatBytes(system.memory.heapTotal);
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
                renderClients(payload.clients);
                renderActiveJobs(payload.activeJobs);
                renderRecentJobs(payload.recentJobs);
                updateSystem(payload.system);
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
