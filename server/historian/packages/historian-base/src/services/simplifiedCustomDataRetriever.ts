import type { ITenantCustomData } from "@fluidframework/server-services-core";
import type { ISimplifiedCustomDataRetriever } from "./definitions";

/**
 * Retrieve simplified customData.
 * @internal
 */
export class SimplifiedCustomDataRetriever implements ISimplifiedCustomDataRetriever {
	public constructor() {}

	public get(customData: ITenantCustomData): string {
		return "";
	}
}
