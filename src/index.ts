import dotenv from 'dotenv';
dotenv.config();
import client from "./core/client";
import { ErrorHandler } from './structures/error-handler';
import express, { json } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { Logger } from './structures/logger';
import { dashboardEnv, getPort } from './config';
import { attachSession } from './middleware/session';
import { createAuthRouter } from './routes/auth-routes';
import { createGuildRouter } from './routes/guild-routes';
import { registerLegacyLogRoutes } from './routes/legacy-log-routes';

client.connect();

client.on('error', err => {
    ErrorHandler.handle(err, { context: 'Uncaught', emitAlert: true });
});

process.on('uncaughtException', err => {
    console.log(err);
    ErrorHandler.handle(err, { context: 'Uncaught Exception', emitAlert: true });
})

process.on('unhandledRejection', err => {
    console.log(err);
    ErrorHandler.handle(err, { context: 'Unhandled Rejection', emitAlert: true });
})

process.on('SIGINT', async () => {
    await Logger.stopLogger();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    await Logger.stopLogger();
    process.exit(0);
});


// API
const app = express();
app.use(cors({
    origin: [
        dashboardEnv.DASHBOARD_URL,
        'http://localhost:5173'
    ],
    credentials: true
}));
app.use(json())
app.use(cookieParser(dashboardEnv.SESSION_COOKIE_SECRET));
app.use(attachSession);

const PORT = getPort();

const authRouter = createAuthRouter();
const guildRouter = createGuildRouter(client);

app.use('/api/auth', authRouter);
app.use('/api', guildRouter);
registerLegacyLogRoutes(app, client);

app.listen(PORT, () => {
    console.log(`Express Server running at http://localhost:${PORT}`)
})
