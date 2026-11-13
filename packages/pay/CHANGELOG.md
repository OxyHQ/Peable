# Changelog

## 0.2.1

Changed:

- The optional `@oxy.so/bloom` peer is open-ended (`>=10.4.0`, was
  `>=10.4.0 <18.0.0`), as Oxy's first-party Bloom peers are
  ([package rules](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/package-rules.md#peer-ranges)),
  so an app on Bloom 18 to 21 installs `@peable.to/pay/ui` without a peer
  conflict. Typechecked and tested against Bloom 21.0.0; nothing the sheet uses
  (`Dialog`, `Button`, `TextField`, `Avatar`, `Divider`, `Text`, `useTheme`)
  changed between Bloom 17 and 21.
