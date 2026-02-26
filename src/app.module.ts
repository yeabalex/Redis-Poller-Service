import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TopTracksModule } from './top-tracks/top-tracks.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,     // ConfigService available everywhere
      envFilePath: '.env',
    }),
    TopTracksModule,
  ],
})
export class AppModule { }
