// TRANSITIONAL: the metadata schemas are contracts (`@peable.to/contracts`
// `metadataCreateParam` / `metadataUpdateParam`). This module only re-exports
// them under their old names while the routes move to the contract imports,
// and is deleted once no route imports it.
export {
  METADATA_KEY_MAX,
  METADATA_LIMIT_MESSAGE,
  METADATA_MAX_KEYS,
  METADATA_VALUE_MAX,
  type MetadataPatch,
  metadataCreateParam as metadataCreateSchema,
  metadataUpdateParam as metadataUpdateSchema,
} from '@peable.to/contracts';
