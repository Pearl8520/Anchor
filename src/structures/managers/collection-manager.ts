import { Collection as DiscordCollection } from "discord.js";
import { AnyBulkWriteOperation, BulkWriteOptions, DeleteOptions, Document, Filter, FindCursor, FindOneAndUpdateOptions, FindOptions, InsertOneOptions, Collection as MongoCollection, OptionalUnlessRequiredId, UpdateFilter, UpdateOptions, WithId } from "mongodb";

export interface FetchOptions {
    /**
     * Whether to make a call to the db
     */
    fetch?: boolean;
    /**
     * Whether to cache the result
     */
    cache?: boolean;
    /**
     * Whether to check the cache
     */
    checkCache?: boolean;
}

export const defaultFetchOptions: FetchOptions = {
    fetch: true,
    cache: true,
    checkCache: true
}
/**
 * Wrapper for Mongo's Collection that provides built in caching
 */
export class CollectionManager<T extends Document, C = T> {
    readonly collection: MongoCollection<T>;
    cache: DiscordCollection<string, C> = new DiscordCollection();

    constructor(collection: MongoCollection<T>) {
        this.collection = collection;
    }

    find(filter: Filter<T> = {}, options?: FindOptions) {
        return this.collection.find(filter, options) as FindCursor<WithId<T>>;
    }

    findOne(filter: Filter<T>, options?: FindOptions) {
        return this.collection.findOne(filter, options) as Promise<T | null>;
    }

    insertMany(docs: readonly OptionalUnlessRequiredId<T>[], options?: BulkWriteOptions) {
        return this.collection.insertMany(docs, options);
    }

    insertOne(doc: OptionalUnlessRequiredId<T>, options?: InsertOneOptions) {
        return this.collection.insertOne(doc, options);
    }

    updateMany(filter: Filter<T>, update: Document[] | UpdateFilter<T>, options?: FindOptions) {
        return this.collection.updateMany(filter, update, options);
    }

    updateOne(filter: Filter<T>, update: Document[] | UpdateFilter<T>, options?: UpdateOptions) {
        return this.collection.updateOne(filter, update, options);
    }

    deleteMany(filter?: Filter<T> | undefined, options?: DeleteOptions) {
        return this.collection.deleteMany(filter, options);
    }

    deleteOne(filter?: Filter<T> | undefined, options?: DeleteOptions) {
        return this.collection.deleteOne(filter, options);
    }

    bulkWrite(operations: AnyBulkWriteOperation<T>[], options?: BulkWriteOptions) {
        return this.collection.bulkWrite(operations, options)
    }

    findOneAndUpdate(filter: Filter<T>, update: Document[] | UpdateFilter<T>, options: FindOneAndUpdateOptions & { includeResultMetadata: true; }) {
        return this.collection.findOneAndUpdate(filter, update, options);
    }

    /**
     * Get a cached item and guarantee its existence
     * @param id the id of the item
     * @returns 
     */
    getCached(id: string) {
        const cached = this.cache.get(id);
        if (!cached) throw new Error('There is no element with that ID.');
        return cached;
    }
}