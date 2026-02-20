import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import {
  MOVIE_RATING_ORDER,
  TV_RATING_ORDER,
} from '@server/constants/contentRatings';
import type { UserSettingsParentalControlsResponse } from '@server/interfaces/api/userSettingsInterfaces';
import axios from 'axios';
import { Form, Formik } from 'formik';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserParentalControlsSettings',
  {
    toastSuccess: 'Parental controls saved successfully!',
    toastFailure: 'Something went wrong while saving parental controls.',
    parentalcontrols: 'Parental Controls',
    parentalcontrolsDescription:
      'Restrict the content ratings visible in Discover for this user.',
    maxmovierating: 'Max Movie Rating (MPAA)',
    maxtvrating: 'Max TV Rating',
    blockunrated: 'Block Unrated Content',
    blockunratedDescription:
      'When enabled, titles without a known content rating will be hidden from Discover.',
    blockadult: 'Block Adult Content',
    blockadultDescription:
      'When enabled, titles flagged as adult by TMDB will be hidden from Discover.',
    noLimit: 'No Limit',
  }
);

const UserParentalControlsSettings = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const router = useRouter();
  const { user } = useUser({
    id: Number(router.query.userId),
  });
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<UserSettingsParentalControlsResponse>(
    user ? `/api/v1/user/${user?.id}/settings/parental-controls` : null
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.parentalcontrols),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.parentalcontrols)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.parentalcontrolsDescription)}
        </p>
      </div>
      <Formik
        initialValues={{
          maxMovieRating: data?.maxMovieRating ?? '',
          maxTvRating: data?.maxTvRating ?? '',
          blockUnrated: data?.blockUnrated ?? false,
          blockAdult: data?.blockAdult ?? false,
        }}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            await axios.post(
              `/api/v1/user/${user?.id}/settings/parental-controls`,
              {
                maxMovieRating: values.maxMovieRating || null,
                maxTvRating: values.maxTvRating || null,
                blockUnrated: values.blockUnrated,
                blockAdult: values.blockAdult,
              }
            );

            addToast(intl.formatMessage(messages.toastSuccess), {
              autoDismiss: true,
              appearance: 'success',
            });
          } catch (e) {
            addToast(intl.formatMessage(messages.toastFailure), {
              autoDismiss: true,
              appearance: 'error',
            });
          } finally {
            revalidate();
          }
        }}
      >
        {({ isSubmitting, values, setFieldValue }) => {
          return (
            <Form className="section">
              <div className="form-row">
                <label htmlFor="maxMovieRating" className="text-label">
                  {intl.formatMessage(messages.maxmovierating)}
                </label>
                <div className="form-input-area">
                  <select
                    id="maxMovieRating"
                    name="maxMovieRating"
                    className="rounded bg-gray-800 px-3 py-2 text-white"
                    value={values.maxMovieRating}
                    onChange={(e) =>
                      setFieldValue('maxMovieRating', e.target.value)
                    }
                  >
                    <option value="">
                      {intl.formatMessage(messages.noLimit)}
                    </option>
                    {MOVIE_RATING_ORDER.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="maxTvRating" className="text-label">
                  {intl.formatMessage(messages.maxtvrating)}
                </label>
                <div className="form-input-area">
                  <select
                    id="maxTvRating"
                    name="maxTvRating"
                    className="rounded bg-gray-800 px-3 py-2 text-white"
                    value={values.maxTvRating}
                    onChange={(e) =>
                      setFieldValue('maxTvRating', e.target.value)
                    }
                  >
                    <option value="">
                      {intl.formatMessage(messages.noLimit)}
                    </option>
                    {TV_RATING_ORDER.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="blockUnrated" className="text-label">
                  <span>{intl.formatMessage(messages.blockunrated)}</span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.blockunratedDescription)}
                  </span>
                </label>
                <div className="form-input-area">
                  <input
                    type="checkbox"
                    id="blockUnrated"
                    name="blockUnrated"
                    checked={values.blockUnrated}
                    onChange={(e) =>
                      setFieldValue('blockUnrated', e.target.checked)
                    }
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="blockAdult" className="text-label">
                  <span>{intl.formatMessage(messages.blockadult)}</span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.blockadultDescription)}
                  </span>
                </label>
                <div className="form-input-area">
                  <input
                    type="checkbox"
                    id="blockAdult"
                    name="blockAdult"
                    checked={values.blockAdult}
                    onChange={(e) =>
                      setFieldValue('blockAdult', e.target.checked)
                    }
                  />
                </div>
              </div>
              <div className="actions">
                <div className="flex justify-end">
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting}
                    >
                      <ArrowDownOnSquareIcon />
                      <span>
                        {isSubmitting
                          ? intl.formatMessage(globalMessages.saving)
                          : intl.formatMessage(globalMessages.save)}
                      </span>
                    </Button>
                  </span>
                </div>
              </div>
            </Form>
          );
        }}
      </Formik>
    </>
  );
};

export default UserParentalControlsSettings;
