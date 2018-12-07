import { IOrderer, IOrdererManager } from "@prague/services-core";
import { KafkaOrdererFactory } from "./kafkaOrderer";
import { LocalOrderManager } from "./localOrderManager";

export class OrdererManager implements IOrdererManager {
    constructor(private localOrderManager: LocalOrderManager, private kafkaFactory?: KafkaOrdererFactory) {
    }

    public async getOrderer(tenantId: string, documentId: string): Promise<IOrderer> {
        if (tenantId === "local" || !this.kafkaFactory) {
            return this.localOrderManager.get(tenantId, documentId);
        } else {
            return this.kafkaFactory.create(tenantId, documentId);
        }
    }
}
