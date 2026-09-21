import { Client } from "discord.js";
import { config } from "../config.js";
import { isSnowflake } from "./util.js";

export async function validateRuntimeConfig(client: Client): Promise<void> {
    if (!isSnowflake(config.devId)) throw new Error('Invalid Owner ID configured.');
    if (!isSnowflake(config.ownerId)) throw new Error('Invalid Owner ID configured.');

    const dev = await client.users.fetch(config.devId, { cache: true }).catch(() => null);
    if (!dev) throw new Error('The configured dev could not be fetched.');

    const owner = await client.users.fetch(config.ownerId, { cache: true }).catch(() => null);
    if (!owner) throw new Error('The configured owner could not be fetched.');
}