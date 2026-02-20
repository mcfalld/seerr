import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserContentRatingLimits1765557160380
  implements MigrationInterface
{
  name = 'AddUserContentRatingLimits1765557160380';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD COLUMN "maxMovieRating" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD COLUMN "maxTvRating" varchar`
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(queryRunner: QueryRunner): Promise<void> {
    // SQLite doesn't support DROP COLUMN before 3.35.0;
    // dropping and recreating the table would be needed for older versions.
    // For forward-only migrations this is acceptable.
  }
}
