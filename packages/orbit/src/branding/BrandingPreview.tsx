import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { t } from '@/i18n';
import type { BrandingPreview as Preview } from './brandingForm';

/**
 * A sketch of the hosted checkout's header and pay button in the merchant's
 * branding — drawn from `brandingPreview`, the same values checkout reads.
 * Plain styles, not theme classes: this is the merchant's look, not Orbit's.
 */
export function BrandingPreview({
  preview,
  merchantName,
}: {
  preview: Preview;
  merchantName: string;
}) {
  const font = { fontFamily: preview.fontFamily };
  return (
    <View
      accessible
      accessibilityLabel={t('branding.preview')}
      style={{
        borderRadius: Math.min(preview.radius, 16),
        borderWidth: 1,
        borderColor: '#d0d7de',
        backgroundColor: '#ffffff',
        padding: 20,
        gap: 16,
        maxWidth: 420,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {preview.showIcon ? (
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: Math.min(preview.radius, 18),
              backgroundColor: preview.accentColor,
            }}
          />
        ) : null}
        {preview.showLogo ? (
          <View
            style={{
              width: 96,
              height: 28,
              borderRadius: 4,
              backgroundColor: preview.accentColor,
              opacity: 0.85,
            }}
          />
        ) : null}
        <Text style={[font, { color: preview.accentColor, fontSize: 16, fontWeight: '600' }]}>
          {merchantName}
        </Text>
      </View>
      <View style={{ gap: 6 }}>
        <Text style={[font, { color: '#57606a', fontSize: 13 }]}>{t('branding.preview.item')}</Text>
        <Text style={[font, { color: preview.accentColor, fontSize: 28, fontWeight: '700' }]}>
          24.00 EUR
        </Text>
      </View>
      <View
        style={{
          borderRadius: preview.radius,
          borderWidth: 1,
          borderColor: '#d0d7de',
          paddingVertical: 10,
          paddingHorizontal: 12,
        }}
      >
        <Text style={[font, { color: '#8c959f', fontSize: 14 }]}>
          {t('branding.preview.email')}
        </Text>
      </View>
      <View
        style={{
          borderRadius: preview.radius,
          backgroundColor: preview.primaryColor,
          paddingVertical: 12,
          alignItems: 'center',
        }}
      >
        <Text style={[font, { color: preview.onPrimary, fontSize: 15, fontWeight: '600' }]}>
          {t('branding.preview.pay')}
        </Text>
      </View>
    </View>
  );
}
