import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { TopTracksService } from './top-tracks.service.js';
import { TopTracksGateway } from './top-tracks.gateway.js';
import { TopTracksController } from './top-tracks.controller.js';

@Module({
    imports: [RedisModule],
    providers: [TopTracksService, TopTracksGateway],
    controllers: [TopTracksController],
})
export class TopTracksModule { }
