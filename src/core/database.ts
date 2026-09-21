import { Db, MongoClient, MongoClientOptions } from "mongodb";
import ModmailSettingsManager from "../structures/managers/modmail-settings-manager.js";
import ModmailThreadManager from "../structures/managers/modmail-thread-manager.js";
import ModmailMessageManager from "../structures/managers/modmail-message-manager.js";
import ModmailSnippetManager from "../structures/managers/modmail-snippet-manager.js";
import ModmailStaffDisplayManager from "../structures/managers/modmail-staff-display-manager.js";
import ModmailBlockManager from "../structures/managers/modmail-block-manager.js";
import SessionManager from "../structures/managers/session-manager.js";

export class MongoDatabase {
    readonly _client: MongoClient;
    readonly _db: Db;

    constructor(dbName: string, options?: MongoClientOptions) {
        const uri = process.env.MONGO_URI;
        if (!uri || !dbName) throw new Error('The value of MONGO_URI and MONGO_DB must not be null.')
        this._client = new MongoClient(uri, options);
        this._db = this._client.db(dbName);
    }

    async connect() {
        await this._client.connect();
    }
}

class MainDatabase extends MongoDatabase {
    private _modmailSettings: ModmailSettingsManager;
    private _modmailThreads: ModmailThreadManager;
    private _modmailMessages: ModmailMessageManager;
    private _modmailSnippets: ModmailSnippetManager;
    private _modmailStaffDisplay: ModmailStaffDisplayManager;
    private _modmailBlocks: ModmailBlockManager;
    private _sessions: SessionManager;

    constructor(dbName: string, options?: MongoClientOptions) {
        super(dbName, options);

        this._modmailSettings = new ModmailSettingsManager(this._db.collection('modmail_settings'));
        this._modmailThreads = new ModmailThreadManager(this._db.collection('modmail_threads'));
        this._modmailMessages = new ModmailMessageManager(this._db.collection('modmail_messages'));
        this._modmailSnippets = new ModmailSnippetManager(this._db.collection('modmail_snippets'));
        this._modmailStaffDisplay = new ModmailStaffDisplayManager(this._db.collection('modmail_staff_display'));
        this._modmailBlocks = new ModmailBlockManager(this._db.collection('modmail_blocks'));
        this._sessions = new SessionManager(this._db.collection('sessions'));
    }

    async connect() {
        await this._client.connect();

        await this._modmailSettings.collection.createIndex({ guildId: 1 }, { unique: true });
        await this._modmailThreads.collection.createIndex({ id: 1 }, { unique: true });
        await this._modmailThreads.collection.createIndex({ guildId: 1, userId: 1, status: 1 });
        await this._modmailThreads.collection.createIndex({ channelId: 1 });
        await this._modmailMessages.collection.createIndex({ modmailThreadId: 1 });
        await this._modmailSnippets.collection.createIndex({ guildId: 1, trigger: 1 }, { unique: true });
        await this._modmailStaffDisplay.collection.createIndex({ guildId: 1, userId: 1 }, { unique: true });
        await this._modmailBlocks.collection.createIndex({ guildId: 1, userId: 1 }, { unique: true });

        await this._sessions.collection.createIndex({ id: 1 }, { unique: true });
        await this._sessions.collection.createIndex({ userId: 1 });
        await this._sessions.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    }

    get modmailSettings() { return this._modmailSettings; }
    get modmailThreads() { return this._modmailThreads; }
    get modmailMessages() { return this._modmailMessages; }
    get modmailSnippets() { return this._modmailSnippets; }
    get modmailStaffDisplay() { return this._modmailStaffDisplay; }
    get modmailBlocks() { return this._modmailBlocks; }
    get sessions() { return this._sessions; }
}

const database = new MainDatabase(process.env.MONGO_DB!);
export { database };
