"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
const indexer_metrics_service_1 = require("./indexer/indexer-metrics.service");
function isAddrInUse(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }
    return error.code === 'EADDRINUSE';
}
async function listenWithPortFallback(app, preferredPort, explicitPortProvided) {
    try {
        await app.listen(preferredPort);
        return preferredPort;
    }
    catch (error) {
        if (!isAddrInUse(error)) {
            throw error;
        }
        if (explicitPortProvided) {
            throw new Error(`Port ${preferredPort} is already in use. Set a different PORT value and retry.`);
        }
        const fallbackPort = preferredPort + 1;
        // eslint-disable-next-line no-console
        console.warn(`Port ${preferredPort} is already in use; falling back to port ${fallbackPort}. Set PORT to override.`);
        await app.listen(fallbackPort);
        return fallbackPort;
    }
}
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    const indexerMetricsService = app.get(indexer_metrics_service_1.IndexerMetricsService);
    indexerMetricsService.startPolling();
    app.enableShutdownHooks();
    app
        .getHttpAdapter()
        .getInstance()
        .on('close', () => {
        indexerMetricsService.stopPolling();
    });
    const explicitPortProvided = typeof process.env.PORT === 'string';
    const requestedPort = explicitPortProvided ? Number(process.env.PORT) : 4444;
    if (!Number.isInteger(requestedPort) || requestedPort <= 0) {
        throw new Error(`Invalid PORT value: ${process.env.PORT}`);
    }
    const port = await listenWithPortFallback(app, requestedPort, explicitPortProvided);
    // eslint-disable-next-line no-console
    console.log(`Citizen explorer backend running on http://localhost:${port}`);
}
bootstrap();
