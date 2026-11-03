import { useState } from 'react';
import { Platform, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import type { FileObject, FileUploadPurpose } from '@peable.to/shared-types';
import { FileUpload, type FileUploadFile } from '@oxy.so/bloom/file-upload';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '../api/client';
import type { DashboardScope } from '../api/dashboard';
import { describeError } from '../api/transport';
import { allowedExtensions, fileRefusal, ORBIT_FILE_POLICIES } from '../disputes/evidence';
import { t } from '../i18n';
import { FILE_UPLOAD_ACTION } from '@peable.to/contracts/vocabulary';
import { useDashboardPermissions } from '../scope/useDashboardPermissions';

/**
 * Upload one file for one purpose and hand back its `file_…`.
 *
 * The purpose's policy (types, size) is checked here only to explain a
 * refusal before a round trip; the gateway recognises the format from the
 * bytes and is the authority. The bytes go straight from the picker to the
 * gateway: they are never read into state, logged or cached.
 *
 * Disabled when the person lacks what the purpose's USE needs
 * (`FILE_UPLOAD_ACTION`); the page's `PermissionNotice` says why.
 *
 * Web only for now: a native build has no document picker wired, and says so
 * rather than offering a drop zone that cannot open.
 */
export function FileUploadField({
  scope,
  purpose,
  label,
  disabled,
  onUploaded,
}: {
  scope: DashboardScope;
  /** Only a purpose a merchant may upload: a report's CSV is Peable's own output. */
  purpose: FileUploadPurpose;
  label: string;
  disabled?: boolean;
  onUploaded: (file: FileObject) => void;
}) {
  const { can } = useDashboardPermissions();
  const allowed = can(FILE_UPLOAD_ACTION[purpose]);
  const [picked, setPicked] = useState<FileUploadFile | null>(null);
  const [progress, setProgress] = useState(0);

  const upload = useMutation({
    mutationFn: (file: FileUploadFile) => {
      const raw = file.raw;
      if (!(raw instanceof Blob)) throw new Error(t('files.unreadable'));
      return dashboardApi.files.upload(scope, { purpose, file: raw, filename: file.name });
    },
    onSuccess: (stored) => {
      setProgress(100);
      onUploaded(stored);
    },
    onError: (error) => {
      setPicked(null);
      setProgress(0);
      toast.error(describeError(error, t('files.failed')));
    },
  });

  if (Platform.OS !== 'web') {
    return (
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('files.webOnly')}
      </Text>
    );
  }

  const policy = ORBIT_FILE_POLICIES[purpose];
  return (
    <View className="gap-1.5">
      <FileUpload
        accessibilityLabel={label}
        allowedExtensions={allowedExtensions(purpose)}
        maxBytes={policy.max_bytes}
        disabled={disabled || !allowed || upload.isPending}
        file={picked}
        progress={progress}
        onFileSelected={(file) => {
          const refusal = fileRefusal(file, purpose);
          if (refusal) {
            toast.error(refusal);
            return;
          }
          setPicked(file);
          setProgress(10);
          upload.mutate(file);
        }}
        onReject={(message) => toast.error(message)}
        onUploadComplete={() => {
          setPicked(null);
          setProgress(0);
        }}
      />
    </View>
  );
}
