# Redis development db folder

## Backup RedisToGo production data

Run

    heroku config

to get RedisToGo auth data.

Copy development configuration to a new file

    cp config/redis.conf config/redis_backup.conf

Update configuration file of replica instance

    slaveof <masterip> <masterport>
    
    masterauth <master-password>

where `<masterip>`, `<masterport>` and `<master-password>` are taken from `REDISTOGO_URL` heroku config attribute.

Remember to update also `dbfilename` configuration parameter to avoid overwriting of development database dump.

See more at https://redistogo.com/documentation/exporting