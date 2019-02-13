import {
    OperationType,
    SharedObject,
} from "@prague/api-definitions";
import {
    FileMode,
    IDocumentMessage,
    ISequencedDocumentMessage,
    ITree,
    TreeEntry,
} from "@prague/container-definitions";
import {
    IObjectStorageService,
    IRuntime,
} from "@prague/runtime-definitions";
import { debug } from "./debug";
import { IMapOperation } from "./definitions";
import { MapExtension } from "./extension";
import { IMapView, ISharedMap, IValueChanged, IValueOperation, IValueType, SerializeFilter } from "./interfaces";
import { MapView } from "./view";

const snapshotFileName = "header";
const contentPath = "content";
const keyPath = "keys";

/**
 * Copies all values from the provided MapView to the given Map
 */
export function copyMap(from: IMapView, to: Map<string, any>) {
    from.forEach((value, key) => {
        /* tslint:disable:no-unsafe-any */
        to.set(key, value);
    });
}

class ContentObjectStorage implements IObjectStorageService {
    constructor(private readonly storage: IObjectStorageService) {
    }

    /* tslint:disable:promise-function-async */
    public read(path: string): Promise<string> {
        return this.storage.read(`content/${path}`);
    }
}

interface IMapMessageHandler {
    prepare(op: IMapOperation, local: boolean, message: ISequencedDocumentMessage): Promise<any>;
    process(op: IMapOperation, context: any, local: boolean, message: ISequencedDocumentMessage): void;
}

/**
 * Implementation of a map shared object
 */
export class SharedMap extends SharedObject implements ISharedMap {
    private readonly messageHandler: Map<string, IMapMessageHandler>;
    private readonly view: MapView;
    private serializeFilter: SerializeFilter;
    private readonly valueTypes = new Map<string, IValueType<any>>();

    /**
     * Constructs a new shared map. If the object is non-local an id and service interfaces will
     * be provided
     */
    constructor(
        id: string,
        runtime: IRuntime,
        type = MapExtension.Type) {

        super(id, runtime, type);
        const defaultPrepare = (op: IMapOperation, local: boolean) => Promise.resolve();
        this.serializeFilter = (key, value, valueType) => value;

        this.messageHandler = new Map<string, IMapMessageHandler>();
        // tslint:disable:no-backbone-get-set-outside-model
        this.messageHandler.set(
            "clear",
            {
                prepare: defaultPrepare,
                process: (op, context, local, message) => {
                    if (local) {
                        return;
                    }

                    this.view.clearCore(local, message);
                },
            });
        this.messageHandler.set(
            "delete",
            {
                prepare: defaultPrepare,
                process: (op, context, local, message) => {
                    if (local) {
                        return;
                    }

                    return this.view.deleteCore(op.key, local, message);
                },
            });
        this.messageHandler.set(
            "set",
            {
                prepare: (op, local) => {
                    return local ? Promise.resolve(null) : this.view.prepareSetCore(op.key, op.value);
                },
                process: (op, context, local, message) => {
                    if (local) {
                        return;
                    }

                    this.view.setCore(op.key, context, local, message);
                },
            });

        this.view = new MapView(
            this,
            this.runtime,
            this.id);
    }

    public async keys(): Promise<string[]> {
        return Promise.resolve(Array.from(this.view.keys()));
    }

    /**
     * Retrieves the value with the given key from the map.
     */
    public get(key: string) {
        return Promise.resolve(this.view.get(key));
    }

    public async wait<T>(key: string): Promise<T> {
        return this.view.wait<T>(key);
    }

    public has(key: string): Promise<boolean> {
        return Promise.resolve(this.view.has(key));
    }

    public set<T>(key: string, value: any, type?: string): T {
        return this.view.set(key, value, type);
    }

    public delete(key: string): Promise<boolean> {
        return Promise.resolve(this.view.delete(key));
    }

    public clear(): Promise<void> {
        return Promise.resolve(this.view.clear());
    }

    public ready(): Promise<void> {
        return this.readyContent();
    }

    public snapshot(): ITree {
        const tree: ITree = {
            entries: [
                {
                    mode: FileMode.File,
                    path: snapshotFileName,
                    type: TreeEntry[TreeEntry.Blob],
                    value: {
                        contents: this.view.serialize(this.serializeFilter),
                        encoding: "utf-8",
                    },
                },
            ],
        };

        // Add in the directory structure of any links within the map
        const keysTree: ITree = {
            entries: [],
        };
        this.view.forEach((value, key) => {
            if (value instanceof SharedObject) {
                const id = value.id;
                const path = encodeURIComponent(key);

                keysTree.entries.push({
                    mode: FileMode.Symlink,
                    path,
                    type: TreeEntry[TreeEntry.Blob],
                    value: {
                        contents: `${encodeURIComponent(id)}`,
                        encoding: "utf-8",
                    },
                });
            }
        });
        if (keysTree.entries.length > 0) {
            tree.entries.push({
                mode: FileMode.Directory,
                path: keyPath,
                type: TreeEntry[TreeEntry.Tree],
                value: keysTree,
            });
        }

        // Add the snapshot of the content to the tree
        const contentSnapshot = this.snapshotContent();
        if (contentSnapshot) {
            tree.entries.push({
                mode: FileMode.Directory,
                path: contentPath,
                type: TreeEntry[TreeEntry.Tree],
                value: contentSnapshot,
            });
        }

        return tree;
    }

    public transform(
        message: any,
        referenceSequenceNumber: number,
        sequenceNumber: number,
    ): any {
        const handled = this.messageHandler.has((message as IMapOperation).type);

        return handled ? message : this.transformContent(message, referenceSequenceNumber, sequenceNumber);
    }

    public submitMapMessage(op: any): void {
        // Local operations do not require any extra processing
        if (this.isLocal()) {
            return;
        }

        // Once we have performed the attach submit the local operation
        this.submitLocalMessage(op);
    }

    /**
     * Returns a synchronous view of the map
     */
    public getView(): Promise<IMapView> {
        return Promise.resolve(this.view);
    }

    /**
     * Registers a new value type on the map
     */
    public registerValueType<T>(type: IValueType<T>) {
        this.valueTypes.set(type.name, type);

        function getOpHandler(op: IMapOperation): IValueOperation<T> {
            const handler = type.ops.get(op.value.type);
            if (!handler) {
                throw new Error("Unknown type message");
            }

            return handler;
        }

        const valueTypeMessageHandler: IMapMessageHandler = {
            prepare: async (op, local, message) => {
                const handler = getOpHandler(op);
                const value = this.view.get(op.key);
                return handler.prepare(value, op.value.value, local, message);
            },

            process: (op, context, local, message) => {
                const handler = getOpHandler(op);
                const value = this.view.get(op.key);
                handler.process(value, op.value.value, context, local, message);
                this.emit("valueChanged", { key: op.key }, local, message);
            },
        };

        this.messageHandler.set(type.name, valueTypeMessageHandler);
    }

    public hasValueType(type: string): boolean {
        return this.valueTypes.has(type);
    }

    public getValueType(type: string) {
        return this.valueTypes.get(type);
    }

    public registerSerializeFilter(filter: SerializeFilter) {
        this.serializeFilter = filter;
    }

    public on(event: "pre-op" | "op", listener: (op: ISequencedDocumentMessage, local: boolean) => void): this;
    public on(
        event: "valueChanged",
        listener: (changed: IValueChanged, local: boolean, op: ISequencedDocumentMessage) => void): this;
    public on(event: string | symbol, listener: (...args: any[]) => void): this;

    /* tslint:disable:no-unnecessary-override */
    public on(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    protected readyContent(): Promise<void> {
        return Promise.resolve();
    }

    protected onDisconnect() {
        debug(`Map ${this.id} is now disconnected`);
        this.onDisconnectContent();
    }

    protected onConnect(pending: IDocumentMessage[]) {
        debug(`Map ${this.id} is now connected`);

        // Filter the nonAck and pending mesages into a map set and a content set.
        const mapMessages: IDocumentMessage[] = [];
        const contentMessages: IDocumentMessage[] = [];
        for (const message of pending) {
            if (this.isMapMessage(message)) {
                mapMessages.push(message);
            } else {
                contentMessages.push(message);
            }
        }

        // Deal with the map messages - for the map it's always last one wins so we just resend
        for (const message of mapMessages) {
            this.submitLocalMessage(message.contents);
        }

        // Allow content to catch up
        this.onConnectContent(contentMessages);
    }

    protected async loadCore(
        minimumSequenceNumber: number,
        messages: ISequencedDocumentMessage[],
        headerOrigin: string,
        storage: IObjectStorageService) {

        const header = await storage.read(snapshotFileName);

        const data = header ? JSON.parse(Buffer.from(header, "base64")
            .toString("utf-8")) : {};
        await this.view.populate(data);

        const contentMessages = messages.filter((message) => !this.messageHandler.has(message.contents.type));

        const contentStorage = new ContentObjectStorage(storage);
        await this.loadContent(
            minimumSequenceNumber,
            contentMessages,
            headerOrigin,
            contentStorage);
    }

    protected initializeLocalCore() {
        this.initializeContent();
    }

    protected processMinSequenceNumberChanged(value: number) {
        this.processMinSequenceNumberChangedContent(value);
    }

    protected async loadContent(
        minimumSequenceNumber: number,
        messages: ISequencedDocumentMessage[],
        headerOrigin: string,
        services: IObjectStorageService): Promise<void> {
        return;
    }

    protected initializeContent() {
        return;
    }

    protected prepareCore(message: ISequencedDocumentMessage, local: boolean): Promise<any> {
        if (message.type === OperationType) {
            const op: IMapOperation = message.contents;
            if (this.messageHandler.has(op.type)) {
                return this.messageHandler.get(op.type)
                    .prepare(op, local, message);
            }
        }

        return this.prepareContent(message, local);
    }

    protected processCore(message: ISequencedDocumentMessage, local: boolean, context: any) {
        let handled = false;
        if (message.type === OperationType) {
            const op: IMapOperation = message.contents;
            if (this.messageHandler.has(op.type)) {
                this.messageHandler.get(op.type)
                    .process(op, context, local, message);
                handled = true;
            }
        }

        if (!handled) {
            this.processContent(message, local, context);
        }
    }

    protected attachCore() {
        this.view.attachAll();

        this.attachContent();
    }

    // The following three methods enable derived classes to provide custom content that is stored
    // with the map

    protected attachContent() {
        return;
    }

    protected async prepareContent(message: ISequencedDocumentMessage, local: boolean): Promise<any> {
        return Promise.resolve();
    }

    /**
     * Processes a content message
     */
    protected processContent(message: ISequencedDocumentMessage, local: boolean, context: any) {
        return;
    }

    /**
     * Message sent to notify derived content of disconnection
     */
    protected onDisconnectContent() {
        return;
    }

    /**
     * Message sent upon reconnecting to the delta stream
     */
    protected onConnectContent(pending: IDocumentMessage[]) {
        for (const message of pending) {
            this.submitLocalMessage(message.contents);
        }

        return;
    }

    /**
     * Snapshots the content
     */
    protected snapshotContent(): ITree {
        return null;
    }

    /**
     * Notifies the content that the minimum sequence number has changed
     */
    protected processMinSequenceNumberChangedContent(value: number) {
        return;
    }

    /**
     * Allows derived classes to transform the given message
     */
    protected transformContent(
        message: any,
        referenceSequenceNumber: number,
        sequenceNumber: number,
    ): any {
        return message;
    }

    private isMapMessage(message: IDocumentMessage): boolean {
        const type = message.contents.type;
        return this.messageHandler.has(type);
    }
}
