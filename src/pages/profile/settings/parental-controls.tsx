import UserSettings from '@app/components/UserProfile/UserSettings';
import UserParentalControlsSettings from '@app/components/UserProfile/UserSettings/UserParentalControlsSettings';
import type { NextPage } from 'next';

const UserParentalControlsPage: NextPage = () => {
  return (
    <UserSettings>
      <UserParentalControlsSettings />
    </UserSettings>
  );
};

export default UserParentalControlsPage;
