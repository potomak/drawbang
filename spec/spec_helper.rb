require 'server'

require 'rack/test'
require 'rspec'

# set test environment
set :environment, :test
set :run, false
set :raise_errors, true
set :logging, false

# omniauth test configuration
# see https://github.com/intridea/omniauth/wiki/Integration-Testing
OmniAuth.config.test_mode = true