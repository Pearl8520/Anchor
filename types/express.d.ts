export {};

declare global {
    namespace Express {
        interface Request {
            user?: {
                sessionId: string;
                userId: string;
                username: string;
                avatar: string | null;
            };
        }
    }
}
