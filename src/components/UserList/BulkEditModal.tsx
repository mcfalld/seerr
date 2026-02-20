import Modal from '@app/components/Common/Modal';
import PermissionEdit from '@app/components/PermissionEdit';
import type { User } from '@app/hooks/useUser';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  MOVIE_RATING_ORDER,
  TV_RATING_ORDER,
} from '@server/constants/contentRatings';
import { hasPermission } from '@server/lib/permissions';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';

interface BulkEditProps {
  selectedUserIds: number[];
  users?: User[];
  onCancel?: () => void;
  onComplete?: (updatedUsers: User[]) => void;
  onSaving?: (isSaving: boolean) => void;
}

const messages = defineMessages('components.UserList', {
  userssaved: 'User permissions saved successfully!',
  userfail: 'Something went wrong while saving user permissions.',
  edituser: 'Edit User Permissions',
  parentalcontrols: 'Parental Controls',
  maxmovierating: 'Max Movie Rating',
  maxtvrating: 'Max TV Rating',
  blockunrated: 'Block Unrated Content',
  blockadult: 'Block Adult Content',
  noLimit: 'No Limit',
});

const BulkEditModal = ({
  selectedUserIds,
  users,
  onCancel,
  onComplete,
  onSaving,
}: BulkEditProps) => {
  const { user: currentUser } = useUser();
  const intl = useIntl();
  const { addToast } = useToasts();
  const [currentPermission, setCurrentPermission] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [maxMovieRating, setMaxMovieRating] = useState<string>('');
  const [maxTvRating, setMaxTvRating] = useState<string>('');
  const [blockUnrated, setBlockUnrated] = useState(false);
  const [blockAdult, setBlockAdult] = useState(false);

  useEffect(() => {
    if (onSaving) {
      onSaving(isSaving);
    }
  }, [isSaving, onSaving]);

  const updateUsers = async () => {
    try {
      setIsSaving(true);
      const { data: updated } = await axios.put<User[]>(`/api/v1/user`, {
        ids: selectedUserIds,
        permissions: currentPermission,
        maxMovieRating: maxMovieRating || null,
        maxTvRating: maxTvRating || null,
        blockUnrated,
        blockAdult,
      });
      if (onComplete) {
        onComplete(updated);
      }
      addToast(intl.formatMessage(messages.userssaved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      addToast(intl.formatMessage(messages.userfail), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    if (users) {
      const selectedUsers = users.filter((u) => selectedUserIds.includes(u.id));
      const { permissions: allPermissionsEqual } = selectedUsers.reduce(
        ({ permissions: aPerms }, { permissions: bPerms }) => {
          return {
            permissions:
              aPerms === bPerms || hasPermission(Permission.ADMIN, aPerms)
                ? aPerms
                : NaN,
          };
        },
        { permissions: selectedUsers[0].permissions }
      );
      if (allPermissionsEqual) {
        setCurrentPermission(allPermissionsEqual);
      }
    }
  }, [users, selectedUserIds]);

  return (
    <Modal
      title={intl.formatMessage(messages.edituser)}
      onOk={() => {
        updateUsers();
      }}
      okDisabled={isSaving}
      okText={intl.formatMessage(globalMessages.save)}
      onCancel={onCancel}
    >
      <div className="mb-6">
        <PermissionEdit
          actingUser={currentUser}
          currentPermission={currentPermission}
          onUpdate={(newPermission) => setCurrentPermission(newPermission)}
        />
      </div>
      <div className="mt-6 border-t border-gray-700 pt-6">
        <h3 className="heading mb-4">
          {intl.formatMessage(messages.parentalcontrols)}
        </h3>
        <div className="form-row">
          <label className="text-label">
            {intl.formatMessage(messages.maxmovierating)}
          </label>
          <div className="form-input-area">
            <select
              className="rounded bg-gray-800 px-3 py-2 text-white"
              value={maxMovieRating}
              onChange={(e) => setMaxMovieRating(e.target.value)}
            >
              <option value="">{intl.formatMessage(messages.noLimit)}</option>
              {MOVIE_RATING_ORDER.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="form-row">
          <label className="text-label">
            {intl.formatMessage(messages.maxtvrating)}
          </label>
          <div className="form-input-area">
            <select
              className="rounded bg-gray-800 px-3 py-2 text-white"
              value={maxTvRating}
              onChange={(e) => setMaxTvRating(e.target.value)}
            >
              <option value="">{intl.formatMessage(messages.noLimit)}</option>
              {TV_RATING_ORDER.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="form-row">
          <label className="text-label">
            {intl.formatMessage(messages.blockunrated)}
          </label>
          <div className="form-input-area">
            <input
              type="checkbox"
              checked={blockUnrated}
              onChange={(e) => setBlockUnrated(e.target.checked)}
            />
          </div>
        </div>
        <div className="form-row">
          <label className="text-label">
            {intl.formatMessage(messages.blockadult)}
          </label>
          <div className="form-input-area">
            <input
              type="checkbox"
              checked={blockAdult}
              onChange={(e) => setBlockAdult(e.target.checked)}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default BulkEditModal;
